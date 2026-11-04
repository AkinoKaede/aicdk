package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"net/netip"
	"path"
	"strings"
	"time"

	"cdk/internal/config"
	"cdk/internal/partner"
	"cdk/internal/store"

	"github.com/gin-gonic/gin"
)

type Server struct {
	config  config.Config
	store   *store.Store
	adapter partner.Adapter
	assets  fs.FS
	trusted []netip.Prefix
	limits  limiter
	slots   chan struct{}
	router  *gin.Engine
}

func New(c config.Config, db *store.Store, adapter partner.Adapter, assets fs.FS) (*Server, error) {
	s := &Server{config: c, store: db, adapter: adapter, assets: assets, slots: make(chan struct{}, 64)}
	if len(s.config.IPHeaders) == 0 {
		s.config.IPHeaders = []string{"X-Forwarded-For", "X-Real-IP"}
	}
	for _, header := range s.config.IPHeaders {
		switch strings.ToLower(header) {
		case "x-forwarded-for", "x-real-ip", "cf-connecting-ip", "true-client-ip":
		default:
			return nil, errors.New("CLIENT_IP_HEADERS supports X-Forwarded-For, X-Real-IP, CF-Connecting-IP and True-Client-IP")
		}
	}
	for _, raw := range c.TrustedProxy {
		prefix, err := netip.ParsePrefix(raw)
		if err != nil {
			return nil, errors.New("invalid TRUSTED_PROXY_CIDRS")
		}
		s.trusted = append(s.trusted, prefix)
	}
	router, err := s.newRouter()
	if err != nil {
		return nil, err
	}
	s.router = router
	return s, nil
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.router.ServeHTTP(w, r)
}

func (s *Server) newRouter() (*gin.Engine, error) {
	router := gin.New()
	// Never redirect a submission or let Gin bypass our per-header trust policy.
	router.RedirectTrailingSlash = false
	router.RedirectFixedPath = false
	router.RemoveExtraSlash = false
	router.HandleMethodNotAllowed = true
	router.ForwardedByClientIP = false
	router.RemoteIPHeaders = nil
	router.TrustedPlatform = ""
	if err := router.SetTrustedProxies(nil); err != nil {
		return nil, err
	}
	// Default logging/recovery can include request URLs, cookies, or panic values.
	router.Use(s.securityHeaders, gin.CustomRecoveryWithWriter(nil, s.recoverRequest), s.apiGuard)
	health := func(c *gin.Context) {
		c.Header("Cache-Control", "no-store")
		c.Header("Content-Type", "application/json")
		if c.Request.Method == http.MethodGet {
			c.Data(http.StatusOK, "application/json", []byte(`{"status":"ok"}`))
		}
	}
	router.GET("/healthz", health)
	router.HEAD("/healthz", health)
	api := router.Group("/api")
	api.GET("/session", gin.WrapF(s.session))
	secured := api.Group("", s.requireSession)
	for operation := range fields {
		secured.POST("/"+operation, func(c *gin.Context) {
			s.operation(c.Writer, c.Request, c.GetString(deviceContextKey), operation)
		})
	}
	router.NoRoute(func(c *gin.Context) {
		if isAPIPath(c.Request.URL.Path) {
			s.fail(c.Writer, http.StatusNotFound, "NOT_FOUND", "接口不存在", false)
			return
		}
		s.static(c.Writer, c.Request)
	})
	router.NoMethod(func(c *gin.Context) {
		message := "此接口仅接受 POST"
		if c.Request.URL.Path == "/api/session" || c.Request.URL.Path == "/healthz" {
			message = "此接口仅接受 GET"
		}
		s.fail(c.Writer, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", message, false)
	})
	return router, nil
}

func (s *Server) operation(w http.ResponseWriter, r *http.Request, device, operation string) {
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		s.fail(w, 415, "INVALID_CONTENT_TYPE", "请使用 application/json", false)
		return
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 256<<10))
	if err != nil {
		s.fail(w, 413, "BODY_TOO_LARGE", "请求不能超过 256 KiB", false)
		return
	}
	p, err := validate(raw, operation)
	if err != nil {
		s.fail(w, 400, "INVALID_REQUEST", err.Error(), false)
		return
	}
	timeout := config.QueryTimeout
	if operation == "redeem" {
		timeout = config.RedeemTimeout
	}
	ctx, cancel := context.WithTimeout(r.Context(), timeout)
	defer cancel()
	r = r.WithContext(ctx)
	select {
	case s.slots <- struct{}{}:
		defer func() { <-s.slots }()
	default:
		w.Header().Set("Retry-After", "10")
		s.fail(w, 503, "SERVER_BUSY", "服务繁忙，本次请求尚未转发，请稍后再试", false)
		return
	}
	if operation == "lookup-batch" {
		s.batchLookup(w, r, device, p)
		return
	}
	system, originalCode, err := s.resolve(operation, device, p)
	if err != nil {
		s.fail(w, 422, "ROUTE_UNAVAILABLE", err.Error(), false)
		return
	}
	if operation == "redeem" {
		token := p.text("redemption_token")
		binding, err := s.store.Route(device, token)
		grok := strings.EqualFold(binding.Product, "grok")
		if err != nil || (grok && p["credential"] == nil) || (!grok && p["preflight_token"] == nil) || !s.store.Approved(device, token, proof(p)) {
			s.fail(w, 422, "PREFLIGHT_REQUIRED", "请完成账号预检并解除阻断后再提交", false)
			return
		}
		if err := s.store.Claim(device, token, p.text("client_request_id"), binding.CodeHash); err != nil {
			if errors.Is(err, store.ErrAttemptExists) {
				s.fail(w, 409, "ALREADY_SUBMITTED", "该操作已有提交记录，请查询原单，不要再次提交", true)
			} else {
				s.fail(w, 503, "PERSISTENCE_ERROR", "无法持久化提交记录，本次未发送到上游", false)
			}
			return
		}
	}
	if operation == "preflight" {
		if err := s.store.Approve(device, p.text("redemption_token"), ""); err != nil {
			s.fail(w, 503, "PERSISTENCE_ERROR", "无法更新预检状态，请联系管理员", false)
			return
		}
	}
	body, _ := json.Marshal(p)
	reply, status := s.adapter.Call(r.Context(), system, operation, device, body)
	if reply.OK {
		var data map[string]any
		if json.Unmarshal(reply.Data, &data) != nil || data == nil {
			s.fail(w, 502, "INVALID_RESPONSE", "上游返回数据格式异常，请先查询原记录", operation == "redeem")
			return
		}
		if operation == "preview" {
			token, ok := data["redemption_token"].(string)
			if !ok || token == "" || len(token) > 2048 {
				s.fail(w, 502, "INVALID_RESPONSE", "上游未提供有效兑换凭证", false)
				return
			}
			binding := store.Binding{
				SystemID: system.ID, Origin: system.BaseURL,
				CodeHash: s.store.Hash("code", strings.ToUpper(originalCode)),
			}
			binding.Product, _ = data["product"].(string)
			if err := s.store.Bind(device, token, binding); err != nil {
				s.fail(w, 503, "ROUTE_PERSISTENCE_ERROR", "无法保存验证记录，请联系发卡方。", false)
				return
			}
		}
		if operation == "preflight" {
			email, _ := data["email"].(string)
			if email == "" {
				email, _ = data["account_email"].(string)
			}
			recovery, _ := data["subscription_recovery_required"].(bool)
			if !blockingValue(data["blocking_reason"]) && !recovery && strings.TrimSpace(email) != "" {
				token := p.text("redemption_token")
				binding, _ := s.store.Route(device, token)
				ticket, _ := data["preflight_token"].(string)
				if strings.EqualFold(binding.Product, "grok") {
					ticket = proof(p)
				}
				if ticket != "" {
					if err := s.store.Approve(device, token, ticket); err != nil {
						s.fail(w, 503, "PERSISTENCE_ERROR", "无法保存预检状态，请联系管理员", false)
						return
					}
				}
			}
		}
		data["system_id"], data["system_name"] = system.ID, system.Name
		if operation == "lookup" {
			data["cdk_code"] = originalCode
		}
		reply.Data, _ = json.Marshal(data)
	}
	if status == 429 {
		w.Header().Set("Retry-After", "60")
	}
	s.write(w, status, reply)
}

func (s *Server) resolve(operation, device string, p payload) (config.System, string, error) {
	switch operation {
	case "preview", "lookup", "result-by-code":
		original := strings.TrimSpace(p.text("code"))
		system, code, err := s.config.Match(original)
		p.set("code", code)
		return system, original, err
	case "billing":
		if p["cdk_code"] != nil {
			original := strings.TrimSpace(p.text("cdk_code"))
			system, code, err := s.config.Match(original)
			p.set("cdk_code", code)
			return system, original, err
		}
		id := p.text("system_id")
		delete(p, "system_id")
		if id == "" {
			id = s.config.Default
		}
		for _, system := range s.config.Systems {
			if system.ID == id {
				return system, "", nil
			}
		}
		return config.System{}, "", errors.New("请选择账单查询使用的系统")
	default:
		token := p.text("redemption_token")
		if operation == "result" {
			token = p.text("token")
		}
		binding, err := s.store.Route(device, token)
		if err != nil {
			return config.System{}, "", errors.New("当前浏览器没有这笔兑换的记录，请使用原卡密查询进度。")
		}
		for _, system := range s.config.Systems {
			if system.ID == binding.SystemID && system.BaseURL == binding.Origin {
				if p["code"] != nil {
					original := strings.TrimSpace(p.text("code"))
					if s.store.Hash("code", strings.ToUpper(original)) != binding.CodeHash {
						return config.System{}, "", errors.New("卡密与兑换凭证不匹配")
					}
					match, code, err := s.config.Match(original)
					if err != nil || match.ID != system.ID {
						return config.System{}, "", errors.New("暂时无法继续这笔兑换，请联系发卡方核对原记录。")
					}
					p.set("code", code)
				}
				return system, "", nil
			}
		}
		return config.System{}, "", errors.New("暂时无法继续这笔兑换，请联系发卡方核对原记录。")
	}
}

func (s *Server) batchLookup(w http.ResponseWriter, r *http.Request, device string, p payload) {
	var codes []string
	_ = json.Unmarshal(p["codes"], &codes)
	type row struct {
		index int
		code  string
	}
	groups := map[string][]row{}
	systems := map[string]config.System{}
	results := make([]map[string]any, len(codes))
	for i, original := range codes {
		system, code, err := s.config.Match(original)
		if err != nil {
			results[i] = map[string]any{"cdk_code": original, "status": "unknown", "message": err.Error()}
			continue
		}
		groups[system.ID] = append(groups[system.ID], row{index: i, code: code})
		systems[system.ID] = system
	}
	// Group calls are serial; a failed system cannot discard another's results.
	for id, rows := range groups {
		upstreamCodes := make([]string, len(rows))
		for i, row := range rows {
			upstreamCodes[i] = row.code
		}
		body, _ := json.Marshal(map[string]any{"codes": upstreamCodes})
		reply := partner.Failure("TIMEOUT", "查询超时，请稍后重查", true, false)
		if r.Context().Err() == nil {
			reply, _ = s.adapter.Call(r.Context(), systems[id], "lookup-batch", device, body)
		}
		var data struct {
			Results []map[string]any `json:"results"`
		}
		_ = json.Unmarshal(reply.Data, &data)
		byCode := map[string]map[string]any{}
		for _, result := range data.Results {
			if code, ok := result["cdk_code"].(string); ok {
				byCode[strings.ToUpper(code)] = result
			}
		}
		for _, row := range rows {
			result := map[string]any{}
			if reply.OK && byCode[strings.ToUpper(row.code)] != nil {
				for k, v := range byCode[strings.ToUpper(row.code)] {
					result[k] = v
				}
			} else {
				result["status"] = "unknown"
				result["message"] = "未取得该卡密的可靠查询结果，请稍后重查"
				if reply.Error != nil {
					result["message"] = reply.Error.Message
				}
			}
			result["cdk_code"] = codes[row.index]
			result["system_name"] = systems[id].Name
			results[row.index] = result
		}
	}
	s.success(w, map[string]any{"total": len(codes), "max": 100, "results": results})
}

func proof(p payload) string {
	if p["credential"] != nil {
		var credential struct {
			Session string `json:"session"`
		}
		_ = json.Unmarshal(p["credential"], &credential)
		return "session:" + credential.Session
	}
	return p.text("preflight_token")
}

func blockingValue(value any) bool {
	switch v := value.(type) {
	case nil:
		return false
	case string:
		return strings.TrimSpace(v) != ""
	case bool:
		return v
	default:
		return true
	}
}

func (s *Server) static(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "Method not allowed", 405)
		return
	}
	file := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
	if file == "." || file == "" {
		file = "index.html"
	}
	if _, err := fs.Stat(s.assets, file); err != nil {
		if strings.Contains(path.Base(file), ".") || strings.HasPrefix(file, "assets/") {
			http.NotFound(w, r)
			return
		}
		file = "index.html"
	}
	data, err := fs.ReadFile(s.assets, file)
	if err != nil {
		http.Error(w, "Frontend is not built. Run npm ci && npm run build in web/.", 503)
		return
	}
	if strings.HasPrefix(file, "assets/") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		w.Header().Set("Cache-Control", "no-cache")
	}
	w.Header().Set("Content-Type", mime.TypeByExtension(path.Ext(file)))
	http.ServeContent(w, r, file, time.Time{}, strings.NewReader(string(data)))
}

func (s *Server) success(w http.ResponseWriter, data any) {
	raw, _ := json.Marshal(data)
	s.write(w, 200, partner.Reply{OK: true, Data: raw})
}

func (s *Server) fail(w http.ResponseWriter, status int, code, message string, uncertain bool) {
	s.write(w, status, partner.Failure(code, message, status == 429, uncertain))
}

func (s *Server) write(w http.ResponseWriter, status int, reply partner.Reply) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(reply)
}
