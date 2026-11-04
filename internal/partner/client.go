package partner

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"cdk/internal/config"
)

type APIError struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
	Uncertain bool   `json:"uncertain"`
}

type Reply struct {
	OK    bool            `json:"ok"`
	Data  json.RawMessage `json:"data,omitempty"`
	Error *APIError       `json:"error,omitempty"`
}

// Adapter is the boundary for systems that use a different upstream protocol.
type Adapter interface {
	Call(context.Context, config.System, string, string, []byte) (Reply, int)
}

type Client struct {
	HTTP          *http.Client
	QueryTimeout  time.Duration
	RedeemTimeout time.Duration
}

func New() *Client {
	return &Client{
		HTTP: &http.Client{
			Transport: &http.Transport{
				Proxy: http.ProxyFromEnvironment, MaxIdleConns: 64, MaxIdleConnsPerHost: 16,
				MaxConnsPerHost: 32, IdleConnTimeout: 90 * time.Second,
				TLSHandshakeTimeout: 10 * time.Second, ResponseHeaderTimeout: 150 * time.Second,
			},
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
		QueryTimeout: config.QueryTimeout, RedeemTimeout: config.RedeemTimeout,
	}
}

func Failure(code, message string, retryable, uncertain bool) Reply {
	return Reply{Error: &APIError{Code: code, Message: message, Retryable: retryable, Uncertain: uncertain}}
}

func (c *Client) Call(ctx context.Context, system config.System, operation, device string, body []byte) (Reply, int) {
	isRedeem := operation == "redeem"
	timeout := c.QueryTimeout
	if isRedeem {
		timeout = c.RedeemTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, system.BaseURL+"/api/partner/v1/"+operation, bytes.NewReader(body))
	if err != nil {
		return Failure("UPSTREAM_CONFIG", "兑换系统配置异常，请联系管理员", false, false), 503
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("X-Redemption-Device", device)
	req.SetBasicAuth("partner", system.Password)
	// No retry and no idempotency header: transports must not replay a POST.
	response, err := c.HTTP.Do(req)
	if err != nil {
		return Failure("UPSTREAM_UNAVAILABLE", networkMessage(isRedeem), !isRedeem, isRedeem), 502
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, (2<<20)+1))
	if err != nil || len(raw) > 2<<20 {
		return Failure("INVALID_RESPONSE", networkMessage(isRedeem), !isRedeem, isRedeem), 502
	}
	status := response.StatusCode
	var reply Reply
	err = json.Unmarshal(raw, &reply)
	if status == 401 || status == 403 {
		return Failure("UPSTREAM_AUTH", "兑换系统认证异常，请联系管理员", false, false), 503
	}
	if status >= 300 && status < 400 {
		return Failure("UPSTREAM_REDIRECT", networkMessage(isRedeem), !isRedeem, isRedeem), 502
	}
	if err != nil || (reply.OK && (len(reply.Data) == 0 || bytes.Equal(reply.Data, []byte("null")))) || (!reply.OK && reply.Error == nil) {
		if status == 429 {
			return Failure("RATE_LIMITED", "请求较频繁，请稍后再试", true, false), 429
		}
		if status == 413 {
			return Failure("INVALID_REQUEST", "请求过大，请分批操作", false, false), 413
		}
		return Failure("INVALID_RESPONSE", networkMessage(isRedeem), !isRedeem, isRedeem), 502
	}
	if status < 200 || status >= 300 || !reply.OK {
		if reply.Error == nil {
			reply = Failure("UPSTREAM_UNAVAILABLE", networkMessage(isRedeem), !isRedeem, isRedeem)
		}
		reply.OK = false
		reply.Data = nil
		reply.Error.Uncertain = reply.Error.Uncertain || (isRedeem && status >= 500)
		if isRedeem {
			reply.Error.Retryable = false
		}
		reply.Error.Message = redact(reply.Error.Message, system.Password, body)
		if status < 400 || status > 599 {
			status = 502
		}
	}
	return reply, status
}

func networkMessage(redeem bool) string {
	if redeem {
		return "提交结果待确认，请查询原兑换记录，不要重新提交"
	}
	return "上游暂时无法响应，请稍后查询"
}

func redact(message, password string, body []byte) string {
	message = strings.ReplaceAll(message, password, "[已隐藏]")
	var value any
	if json.Unmarshal(body, &value) == nil {
		var walk func(any)
		walk = func(v any) {
			switch item := v.(type) {
			case string:
				if len(item) >= 6 {
					message = strings.ReplaceAll(message, item, "[已隐藏]")
				}
			case map[string]any:
				for _, x := range item {
					walk(x)
				}
			case []any:
				for _, x := range item {
					walk(x)
				}
			}
		}
		walk(value)
	}
	if len(message) > 1024 {
		return "请求未完成，请核对输入或联系发卡方"
	}
	return message
}
