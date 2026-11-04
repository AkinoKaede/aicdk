package server

import (
	"crypto/hmac"
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

const cookieName = "cdk_device"
const deviceContextKey = "cdk.device"

func isAPIPath(path string) bool {
	return path == "/api" || strings.HasPrefix(path, "/api/")
}

func (s *Server) securityHeaders(c *gin.Context) {
	c.Header("X-Content-Type-Options", "nosniff")
	c.Header("Referrer-Policy", "no-referrer")
	c.Header("X-Frame-Options", "DENY")
	c.Header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
	c.Header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
	if strings.HasPrefix(s.config.PublicOrigin, "https://") {
		c.Header("Strict-Transport-Security", "max-age=31536000")
	}
	c.Next()
}

func (s *Server) apiGuard(c *gin.Context) {
	if !isAPIPath(c.Request.URL.Path) {
		c.Next()
		return
	}
	c.Header("Cache-Control", "no-store")
	if !s.originAllowed(c.Request) {
		c.Abort()
		s.fail(c.Writer, http.StatusForbidden, "ORIGIN_DENIED", "请求来源不被允许", false)
		return
	}
	if !s.limits.allow("ip:"+s.clientIP(c.Request), 300) {
		c.Abort()
		c.Header("Retry-After", "60")
		s.fail(c.Writer, http.StatusTooManyRequests, "RATE_LIMITED", "请求过于频繁，请一分钟后再试", false)
		return
	}
	c.Next()
}

func (s *Server) requireSession(c *gin.Context) {
	device := s.device(c.Request)
	if device == "" {
		c.Abort()
		s.fail(c.Writer, http.StatusUnauthorized, "SESSION_REQUIRED", "浏览器会话已失效，请刷新页面后查询原记录", false)
		return
	}
	if !hmac.Equal([]byte(c.GetHeader("X-CSRF-Token")), []byte(s.store.Hash("csrf", device))) {
		c.Abort()
		s.fail(c.Writer, http.StatusForbidden, "CSRF_REJECTED", "会话验证失败，请刷新页面", false)
		return
	}
	if !s.limits.allow("device:"+device, 120) || (c.FullPath() == "/api/redeem" && !s.limits.allow("submit:"+device, 30)) {
		c.Abort()
		c.Header("Retry-After", "60")
		s.fail(c.Writer, http.StatusTooManyRequests, "RATE_LIMITED", "请求过于频繁，请一分钟后再查询", false)
		return
	}
	c.Set(deviceContextKey, device)
	c.Next()
}

func (s *Server) recoverRequest(c *gin.Context, _ any) {
	c.Abort()
	// Only log the registered route, never request data or the panic value.
	slog.Error("request handler panicked", "route", c.FullPath())
	if !c.Writer.Written() {
		c.Header("Cache-Control", "no-store")
		uncertain := c.Request.Method == http.MethodPost && c.FullPath() == "/api/redeem"
		s.fail(c.Writer, http.StatusInternalServerError, "INTERNAL_ERROR", "响应暂时无法确认，请查询原记录", uncertain)
	}
}

type rateEntry struct {
	start time.Time
	count int
}

type limiter struct {
	mu      sync.Mutex
	entries map[string]rateEntry
	lastGC  time.Time
}

func (l *limiter) allow(key string, max int) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	if l.entries == nil {
		l.entries = make(map[string]rateEntry)
	}
	if now.Sub(l.lastGC) > time.Minute {
		for k, v := range l.entries {
			if now.Sub(v.start) > time.Minute {
				delete(l.entries, k)
			}
		}
		l.lastGC = now
	}
	entry, exists := l.entries[key]
	if !exists && len(l.entries) >= 20000 {
		return false
	}
	if now.Sub(entry.start) >= time.Minute {
		entry = rateEntry{start: now}
	}
	if entry.count >= max {
		return false
	}
	entry.count++
	l.entries[key] = entry
	return true
}

func (s *Server) originAllowed(r *http.Request) bool {
	if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		return false
	}
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	if s.config.PublicOrigin != "" {
		return origin == s.config.PublicOrigin
	}
	u, err := url.Parse(origin)
	return err == nil && (u.Scheme == "https" || u.Scheme == "http") && u.Host == r.Host && u.Path == "" && u.User == nil
}

func (s *Server) device(r *http.Request) string {
	cookie, err := r.Cookie(cookieName)
	if err != nil {
		return ""
	}
	parts := strings.Split(cookie.Value, ".")
	if len(parts) != 2 || len(parts[0]) != 39 || !strings.HasPrefix(parts[0], "device-") {
		return ""
	}
	if _, err := hex.DecodeString(parts[0][7:]); err != nil {
		return ""
	}
	expected := s.store.Hash("cookie", parts[0])
	if !hmac.Equal([]byte(expected), []byte(parts[1])) {
		return ""
	}
	return parts[0]
}

func (s *Server) session(w http.ResponseWriter, r *http.Request) {
	device := s.device(r)
	if device == "" {
		value := make([]byte, 16)
		if _, err := rand.Read(value); err != nil {
			s.fail(w, 500, "SESSION_ERROR", "无法创建浏览器会话", false)
			return
		}
		device = "device-" + hex.EncodeToString(value)
	}
	http.SetCookie(w, &http.Cookie{
		Name: cookieName, Value: device + "." + s.store.Hash("cookie", device),
		Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode,
		Secure: r.TLS != nil || strings.HasPrefix(s.config.PublicOrigin, "https://"),
		MaxAge: 365 * 24 * 60 * 60,
	})
	type publicSystem struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	systems := make([]publicSystem, 0, len(s.config.Systems))
	for _, system := range s.config.Systems {
		systems = append(systems, publicSystem{ID: system.ID, Name: system.Name})
	}
	s.success(w, map[string]any{
		"csrf_token": s.store.Hash("csrf", device), "systems": systems, "default_system": s.config.Default,
	})
}

func (s *Server) clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	peer, err := netip.ParseAddr(host)
	if err != nil {
		return "unknown"
	}
	trusted := func(ip netip.Addr) bool {
		for _, prefix := range s.trusted {
			if prefix.Contains(ip.Unmap()) {
				return true
			}
		}
		return false
	}
	if s.config.TrustProxyHeaders && trusted(peer) {
		for _, header := range s.config.IPHeaders {
			if !s.config.EnabledIPHeaders[strings.ToLower(header)] {
				continue
			}
			raw := r.Header.Get(header)
			if raw == "" {
				continue
			}
			if len(r.Header.Values(header)) != 1 {
				return peer.Unmap().String()
			}
			if !strings.EqualFold(header, "X-Forwarded-For") {
				if ip, err := netip.ParseAddr(strings.TrimSpace(raw)); err == nil {
					return ip.Unmap().String()
				}
				return peer.Unmap().String()
			}
			chain := strings.Split(raw, ",")
			candidate := peer
			for i := len(chain) - 1; i >= 0; i-- {
				ip, err := netip.ParseAddr(strings.TrimSpace(chain[i]))
				if err != nil {
					return peer.Unmap().String()
				}
				candidate = ip
				if !trusted(ip) {
					return candidate.Unmap().String()
				}
			}
			return candidate.Unmap().String()
		}
	}
	return peer.Unmap().String()
}
