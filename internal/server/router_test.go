package server

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"testing/fstest"

	"cdk/internal/config"
	"cdk/internal/partner"

	"github.com/gin-gonic/gin"
)

func TestMain(m *testing.M) {
	gin.SetMode(gin.TestMode)
	os.Exit(m.Run())
}

func TestGinRoutesAndProxyDefaults(t *testing.T) {
	s, _ := fixture(t)
	routes := make(map[string]bool)
	for _, route := range s.router.Routes() {
		routes[route.Method+" "+route.Path] = true
	}
	for operation := range fields {
		if !routes["POST /api/"+operation] {
			t.Errorf("missing explicit Gin route for %s", operation)
		}
	}
	for _, route := range []string{"GET /api/session", "GET /healthz", "HEAD /healthz"} {
		if !routes[route] {
			t.Errorf("missing route: %s", route)
		}
	}
	if len(routes) != len(fields)+3 {
		t.Fatalf("unexpected routes: %v", routes)
	}
	if s.router.ForwardedByClientIP || len(s.router.RemoteIPHeaders) != 0 || s.router.TrustedPlatform != "" {
		t.Fatal("Gin proxy inference must not override application IP controls")
	}
	if s.router.RedirectTrailingSlash || s.router.RedirectFixedPath || s.router.RemoveExtraSlash {
		t.Fatal("API requests must not be redirected or normalized into a valid route")
	}
}

func TestGinAPIErrorsDoNotRedirectOrServeHTML(t *testing.T) {
	s, fake := fixture(t)
	for _, test := range []struct {
		method, path, allow, code string
		status                    int
	}{
		{"GET", "/api/preview", "POST", "METHOD_NOT_ALLOWED", 405},
		{"OPTIONS", "/api/redeem", "POST", "METHOD_NOT_ALLOWED", 405},
		{"POST", "/api/session", "GET", "METHOD_NOT_ALLOWED", 405},
		{"GET", "/api", "", "NOT_FOUND", 404},
		{"GET", "/api/", "", "NOT_FOUND", 404},
		{"GET", "/api/missing", "", "NOT_FOUND", 404},
		{"POST", "/api/missing", "", "NOT_FOUND", 404},
		{"GET", "/api/session/", "", "NOT_FOUND", 404},
		{"POST", "/api/redeem/", "", "NOT_FOUND", 404},
		{"POST", "/api//redeem", "", "NOT_FOUND", 404},
		{"POST", "/api/../api/redeem", "", "NOT_FOUND", 404},
		{"POST", "/api/REDEEM", "", "NOT_FOUND", 404},
	} {
		t.Run(test.method+" "+test.path, func(t *testing.T) {
			r := httptest.NewRequest(test.method, test.path, strings.NewReader("{}"))
			r.Header.Set("X-Forwarded-Prefix", "/untrusted-prefix")
			w := httptest.NewRecorder()
			s.ServeHTTP(w, r)
			var reply partner.Reply
			if err := json.Unmarshal(w.Body.Bytes(), &reply); err != nil {
				t.Fatalf("expected JSON, got %q: %v", w.Body.String(), err)
			}
			if w.Code != test.status || reply.OK || reply.Error == nil || reply.Error.Code != test.code {
				t.Fatalf("unexpected response: %d %s", w.Code, w.Body.String())
			}
			if w.Header().Get("Allow") != test.allow || w.Header().Get("Location") != "" {
				t.Fatalf("unexpected method or redirect headers: %v", w.Header())
			}
			if w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("X-Frame-Options") != "DENY" {
				t.Fatal("fallback handlers bypassed security middleware")
			}
		})
	}
	if len(fake.calls) != 0 {
		t.Fatal("invalid routes reached upstream")
	}
}

func TestGinAPIGuardsCoverFallbackHandlers(t *testing.T) {
	s, fake := fixture(t)
	for _, path := range []string{"/api/session", "/api/preview", "/api/missing", "/api"} {
		r := httptest.NewRequest(http.MethodGet, path, nil)
		r.Header.Set("Origin", "https://attacker.test")
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != 403 || !strings.Contains(w.Body.String(), `"code":"ORIGIN_DENIED"`) {
			t.Fatalf("%s bypassed origin checks: %d %s", path, w.Code, w.Body.String())
		}
	}
	for range 300 {
		s.limits.allow("ip:192.0.2.10", 300)
	}
	for _, path := range []string{"/api/session", "/api/preview", "/api/missing", "/api"} {
		r := httptest.NewRequest(http.MethodGet, path, nil)
		r.RemoteAddr = "192.0.2.10:1234"
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != 429 || w.Header().Get("Retry-After") != "60" {
			t.Fatalf("%s bypassed IP limits: %d %s", path, w.Code, w.Body.String())
		}
	}
	for _, path := range []string{"/healthz", "/redeem"} {
		r := httptest.NewRequest(http.MethodGet, path, nil)
		r.RemoteAddr = "192.0.2.10:1234"
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != 200 {
			t.Fatalf("API throttling blocked %s", path)
		}
	}
	if len(fake.calls) != 0 {
		t.Fatal("rejected request reached upstream")
	}
}

func TestGinIPLimitsUseConfiguredTrustPolicy(t *testing.T) {
	for _, test := range []struct {
		name, peer, limitedIP string
		master, header        bool
	}{
		{"master disabled", "10.0.0.2", "10.0.0.2", false, true},
		{"header disabled", "10.0.0.2", "10.0.0.2", true, false},
		{"untrusted peer", "198.51.100.2", "198.51.100.2", true, true},
		{"trusted proxy", "10.0.0.2", "203.0.113.7", true, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			s, _ := fixture(t)
			cfg := s.config
			cfg.TrustProxyHeaders = test.master
			cfg.TrustedProxy = []string{"10.0.0.0/8"}
			cfg.IPHeaders = []string{"X-Real-IP"}
			cfg.EnabledIPHeaders = map[string]bool{"x-real-ip": test.header}
			s, err := New(cfg, s.store, s.adapter, s.assets)
			if err != nil {
				t.Fatal(err)
			}
			for range 300 {
				s.limits.allow("ip:"+test.limitedIP, 300)
			}
			r := httptest.NewRequest(http.MethodGet, "/api/session", nil)
			r.RemoteAddr = test.peer + ":1234"
			r.Header.Set("X-Real-IP", "203.0.113.7")
			r.Header.Set("X-Forwarded-For", "1.1.1.1")
			w := httptest.NewRecorder()
			s.ServeHTTP(w, r)
			if w.Code != 429 {
				t.Fatalf("request used the wrong client IP: %d %s", w.Code, w.Body.String())
			}
		})
	}
}

func TestGinDeviceAndSubmissionLimits(t *testing.T) {
	for _, test := range []struct {
		name, scope, operation, body string
		limit                        int
	}{
		{"device", "device:", "lookup", `{"code":"A-LIMIT"}`, 120},
		{"submission", "submit:", "redeem", `{"redemption_token":"limit-token","preflight_token":"limit-proof","client_request_id":"limit-request"}`, 30},
	} {
		t.Run(test.name, func(t *testing.T) {
			s, fake := fixture(t)
			cookie, csrf := session(t, s)
			r := httptest.NewRequest(http.MethodPost, "/api/"+test.operation, nil)
			r.AddCookie(cookie)
			device := s.device(r)
			for range test.limit {
				s.limits.allow(test.scope+device, test.limit)
			}
			w := post(s, cookie, csrf, test.operation, test.body)
			if w.Code != 429 || w.Header().Get("Retry-After") != "60" {
				t.Fatalf("middleware did not enforce %s limit: %d %s", test.name, w.Code, w.Body.String())
			}
			if len(fake.calls) != 0 {
				t.Fatal("throttled request reached upstream")
			}
		})
	}
}

func TestGinEmbeddedAssetsAndHealth(t *testing.T) {
	s, _ := fixture(t)
	s.config.PublicOrigin = "https://site.test"
	s.assets = fstest.MapFS{
		"index.html":         &fstest.MapFile{Data: []byte("<!doctype html>app")},
		"assets/app-hash.js": &fstest.MapFile{Data: []byte("console.log('app')")},
	}
	for _, test := range []struct {
		method, path, cache string
		status              int
	}{
		{"GET", "/", "no-cache", 200},
		{"GET", "/redeem", "no-cache", 200},
		{"GET", "/batch", "no-cache", 200},
		{"GET", "/lookup", "no-cache", 200},
		{"GET", "/progress", "no-cache", 200},
		{"GET", "/billing", "no-cache", 200},
		{"GET", "/help", "no-cache", 200},
		{"HEAD", "/redeem", "no-cache", 200},
		{"GET", "/assets/app-hash.js", "public, max-age=31536000, immutable", 200},
		{"HEAD", "/assets/app-hash.js", "public, max-age=31536000, immutable", 200},
		{"GET", "/assets/missing.js", "", 404},
		{"POST", "/redeem", "", 405},
		{"GET", "/healthz", "no-store", 200},
		{"HEAD", "/healthz", "no-store", 200},
	} {
		t.Run(test.method+" "+test.path, func(t *testing.T) {
			w := httptest.NewRecorder()
			s.ServeHTTP(w, httptest.NewRequest(test.method, test.path, nil))
			if w.Code != test.status || w.Header().Get("Cache-Control") != test.cache {
				t.Fatalf("unexpected response: %d %v %s", w.Code, w.Header(), w.Body.String())
			}
			if w.Header().Get("Strict-Transport-Security") != "max-age=31536000" {
				t.Fatal("security middleware did not cover static or health routes")
			}
			if test.method == http.MethodHead && w.Body.Len() != 0 {
				t.Fatal("HEAD response contains a body")
			}
		})
	}
}

type panickingAdapter struct {
	*fakeAdapter
	operation string
}

func (f *panickingAdapter) Call(ctx context.Context, system config.System, operation, device string, body []byte) (partner.Reply, int) {
	reply, status := f.fakeAdapter.Call(ctx, system, operation, device, body)
	if operation == f.operation {
		panic("private-panic-value")
	}
	return reply, status
}

func TestGinRecoveryPreservesSubmissionClaimAndRedactsLogs(t *testing.T) {
	var logs bytes.Buffer
	oldLogger, oldWriter, oldErrorWriter := slog.Default(), gin.DefaultWriter, gin.DefaultErrorWriter
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	gin.DefaultWriter, gin.DefaultErrorWriter = &logs, &logs
	t.Cleanup(func() {
		slog.SetDefault(oldLogger)
		gin.DefaultWriter, gin.DefaultErrorWriter = oldWriter, oldErrorWriter
	})
	s, fake := fixture(t)
	s.adapter = &panickingAdapter{fakeAdapter: fake, operation: "redeem"}
	cookie, csrf := session(t, s)
	if w := post(s, cookie, csrf, "preview", `{"code":"A-PANIC"}`); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if w := post(s, cookie, csrf, "preflight", `{"redemption_token":"token-a-A-PANIC","credential":{"mode":"session","session":"private-session-value"}}`); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	body := `{"redemption_token":"token-a-A-PANIC","preflight_token":"preflight-proof","client_request_id":"panic-request"}`
	r := httptest.NewRequest(http.MethodPost, "/api/redeem?code=private-query-value", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Authorization", "Bearer private-authorization-value")
	r.Header.Set("X-CSRF-Token", csrf)
	r.AddCookie(cookie)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	var reply partner.Reply
	if err := json.Unmarshal(w.Body.Bytes(), &reply); err != nil {
		t.Fatal(err)
	}
	if w.Code != 500 || reply.Error == nil || reply.Error.Code != "INTERNAL_ERROR" || !reply.Error.Uncertain {
		t.Fatalf("panic did not return an uncertain JSON error: %d %s", w.Code, w.Body.String())
	}
	if len(s.slots) != 0 || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("panic leaked an in-flight slot or lost cache protection")
	}
	if retry := post(s, cookie, csrf, "redeem", body); retry.Code != 409 {
		t.Fatalf("panic allowed redemption replay: %d %s", retry.Code, retry.Body.String())
	}
	submissions := 0
	for _, call := range fake.calls {
		if call.Operation == "redeem" {
			submissions++
		}
	}
	if submissions != 1 {
		t.Fatalf("expected one upstream submission, got %d", submissions)
	}
	if !strings.Contains(logs.String(), "request handler panicked") {
		t.Fatal("missing sanitized panic diagnostic")
	}
	for _, secret := range []string{
		"private-panic-value", "private-query-value", "private-authorization-value",
		"private-session-value", "token-a-A-PANIC", "panic-request", csrf, cookie.Value,
	} {
		if strings.Contains(logs.String(), secret) || strings.Contains(w.Body.String(), secret) {
			t.Fatal("recovery exposed request data or a panic value")
		}
	}
}

func TestGinRecoveryDoesNotRewriteCommittedResponse(t *testing.T) {
	s, _ := fixture(t)
	s.router.GET("/partial-response", func(c *gin.Context) {
		c.String(http.StatusOK, "already written")
		panic("private-panic-value")
	})
	w := httptest.NewRecorder()
	s.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/partial-response", nil))
	if w.Code != 200 || w.Body.String() != "already written" {
		t.Fatalf("recovery appended another response: %d %s", w.Code, w.Body.String())
	}
}
