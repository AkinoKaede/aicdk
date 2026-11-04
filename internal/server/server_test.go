package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"testing/fstest"

	"cdk/internal/config"
	"cdk/internal/partner"
	"cdk/internal/store"
)

type call struct {
	System, Operation, Device string
	Body                      payload
}
type fakeAdapter struct {
	mu    sync.Mutex
	calls []call
}

func (f *fakeAdapter) Call(_ context.Context, s config.System, operation, device string, raw []byte) (partner.Reply, int) {
	var p payload
	_ = json.Unmarshal(raw, &p)
	f.mu.Lock()
	f.calls = append(f.calls, call{s.ID, operation, device, p})
	f.mu.Unlock()
	var data any = map[string]any{"status": "queued"}
	status := 200
	switch operation {
	case "preview":
		product := "gpt"
		if strings.Contains(p.text("code"), "GROK") {
			product = "grok"
		}
		data = map[string]any{"redemption_token": "token-" + s.ID + "-" + p.text("code"), "product": product, "plan": "plus"}
	case "preflight":
		var credential struct{ Session string }
		_ = json.Unmarshal(p["credential"], &credential)
		data = map[string]any{"email": "customer@example.test", "currentPlan": "free", "preflight_token": "preflight-proof"}
		if credential.Session == "blocked" {
			data = map[string]any{"email": "customer@example.test", "blocking_reason": "blocked", "preflight_token": "preflight-proof"}
		}
	case "lookup-batch":
		var codes []string
		_ = json.Unmarshal(p["codes"], &codes)
		results := []map[string]any{}
		// Deliberately reverse the response to test identity-based merging.
		for i := len(codes) - 1; i >= 0; i-- {
			results = append(results, map[string]any{"cdk_code": codes[i], "status": "unused", "plan": codes[i]})
		}
		data = map[string]any{"results": results}
	case "redeem":
		status = 202
	}
	result, _ := json.Marshal(data)
	return partner.Reply{OK: true, Data: result}, status
}

func fixture(t *testing.T) (*Server, *fakeAdapter) {
	t.Helper()
	db, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	c := config.Config{Default: "a", Systems: []config.System{
		{ID: "a", Name: "System A", BaseURL: "https://a.test", Prefixes: []string{"A-"}},
		{ID: "b", Name: "System B", BaseURL: "https://b.test", Prefixes: []string{"B-"}, StripPrefix: true},
	}}
	fake := &fakeAdapter{}
	s, err := New(c, db, fake, fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("<!doctype html>app")}})
	if err != nil {
		t.Fatal(err)
	}
	return s, fake
}

func session(t *testing.T, s *Server) (*http.Cookie, string) {
	t.Helper()
	r := httptest.NewRequest("GET", "http://site.test/api/session", nil)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	var body struct {
		Data struct {
			CSRF string `json:"csrf_token"`
		}
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil || body.Data.CSRF == "" {
		t.Fatalf("session failed: %s", w.Body.String())
	}
	return w.Result().Cookies()[0], body.Data.CSRF
}

func post(s *Server, cookie *http.Cookie, csrf, operation, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest("POST", "http://site.test/api/"+operation, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", "http://site.test")
	r.Header.Set("X-CSRF-Token", csrf)
	if cookie != nil {
		r.AddCookie(cookie)
	}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w
}

func TestRoutingAndSubmissionProtection(t *testing.T) {
	s, fake := fixture(t)
	cookie, csrf := session(t, s)
	if w := post(s, cookie, csrf, "preview", `{"code":"B-123"}`); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	body := `{"redemption_token":"token-b-123","preflight_token":"preflight-proof","client_request_id":"request-1"}`
	if w := post(s, cookie, csrf, "redeem", body); w.Code != 422 {
		t.Fatal("submission bypassed preflight")
	}
	if w := post(s, cookie, csrf, "preflight", `{"code":"B-123","redemption_token":"token-b-123","credential":{"mode":"session","session":"complete-session"}}`); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if w := post(s, cookie, csrf, "redeem", body); w.Code != 202 {
		t.Fatal(w.Body.String())
	}
	if w := post(s, cookie, csrf, "redeem", strings.ReplaceAll(body, "request-1", "new-request")); w.Code != 409 || !strings.Contains(w.Body.String(), `"uncertain":true`) {
		t.Fatal("duplicate submission was not blocked")
	}
	if w := post(s, cookie, csrf, "result", `{"token":"token-b-123"}`); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	device := fake.calls[0].Device
	submissions := 0
	for _, call := range fake.calls {
		if call.System != "b" || call.Device != device || device == "" {
			t.Fatal("system or device changed across the flow")
		}
		if call.Operation == "redeem" {
			submissions++
		}
		if call.Body["code"] != nil && call.Body.text("code") != "123" {
			t.Fatal("prefix not removed")
		}
	}
	if submissions != 1 {
		t.Fatalf("upstream submissions: %d", submissions)
	}
	otherCookie, otherCSRF := session(t, s)
	if w := post(s, otherCookie, otherCSRF, "result", `{"token":"token-b-123"}`); w.Code != 422 {
		t.Fatal("token route was shared across devices")
	}
}

func TestBlockedAndGrokPreflight(t *testing.T) {
	for _, test := range []struct {
		code, session, redeem string
		status                int
	}{
		{"A-ONE", "blocked", `"preflight_token":"preflight-proof"`, 422},
		{"A-GROK", "sso-secret", `"credential":{"mode":"session","session":"sso-secret"}`, 202},
		{"A-GROK", "sso-secret", `"credential":{"mode":"session","session":"wrong"}`, 422},
		{"A-GROK", "sso-secret", `"preflight_token":"preflight-proof"`, 422},
	} {
		t.Run(test.code+test.redeem, func(t *testing.T) {
			s, _ := fixture(t)
			cookie, csrf := session(t, s)
			post(s, cookie, csrf, "preview", `{"code":"`+test.code+`"}`)
			token := "token-a-" + test.code
			post(s, cookie, csrf, "preflight", `{"redemption_token":"`+token+`","credential":{"mode":"session","session":"`+test.session+`"}}`)
			w := post(s, cookie, csrf, "redeem", `{"redemption_token":"`+token+`","client_request_id":"request-1",`+test.redeem+`}`)
			if w.Code != test.status {
				t.Fatalf("got %d: %s", w.Code, w.Body.String())
			}
		})
	}
}

func TestBatchLookupKeepsOriginalOrder(t *testing.T) {
	s, _ := fixture(t)
	cookie, csrf := session(t, s)
	w := post(s, cookie, csrf, "lookup-batch", `{"codes":["B-222","A-111","B-333","B-222"]}`)
	var response struct {
		Data struct {
			Results []map[string]any `json:"results"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil || w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	for i, code := range []string{"B-222", "A-111", "B-333", "B-222"} {
		result := response.Data.Results[i]
		if result["cdk_code"] != code {
			t.Fatalf("row %d was reordered", i)
		}
	}
	if response.Data.Results[0]["plan"] != "222" || response.Data.Results[2]["plan"] != "333" {
		t.Fatal("out-of-order upstream response was paired by index")
	}
}

func TestPrivateRoutingRules(t *testing.T) {
	s, fake := fixture(t)
	s.config.Default = ""
	w := httptest.NewRecorder()
	s.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/session", nil))
	if w.Code != 200 || strings.Contains(w.Body.String(), `"prefixes"`) || strings.Contains(w.Body.String(), `"B-"`) {
		t.Fatal("session must not advertise the configured prefixes")
	}
	cookie, csrf := session(t, s)
	for _, code := range []string{"UNKNOWN", "B-"} {
		w := post(s, cookie, csrf, "result-by-code", `{"code":"`+code+`"}`)
		if w.Code != 422 || strings.Contains(w.Body.String(), "前缀") {
			t.Fatal("invalid code exposed routing rules")
		}
	}
	w = post(s, cookie, csrf, "result-by-code", `{"code":"B-Abc123"}`)
	if w.Code != 200 || len(fake.calls) != 1 || fake.calls[0].Operation != "result-by-code" || fake.calls[0].System != "b" || fake.calls[0].Body.text("code") != "Abc123" {
		t.Fatal("progress queries must send the original upstream code to the matching provider")
	}
}

func TestSecurityBoundaries(t *testing.T) {
	s, _ := fixture(t)
	cookie, csrf := session(t, s)
	for _, test := range []struct {
		op, body string
		status   int
	}{
		{"http://evil.test", `{}`, 404},
		{"preview", `{"code":"A","url":"https://evil.test"}`, 400},
		{"preview", `{"code":null}`, 400},
		{"preview", `{"code":"A"}{"code":"B"}`, 400},
		{"billing", `{"cdk_code":"A","system_id":"b"}`, 400},
		{"billing", `{"token_input":"session","cdk_code":"A"}`, 400},
		{"lookup-batch", `{"codes":["A",""]}`, 400},
		{"preview", `{"code":"` + strings.Repeat("x", 270000) + `"}`, 413},
	} {
		if w := post(s, cookie, csrf, test.op, test.body); w.Code != test.status {
			t.Errorf("%s: got %d, want %d: %s", test.op, w.Code, test.status, w.Body.String())
		}
	}
	if w := post(s, nil, csrf, "preview", `{"code":"A"}`); w.Code != 401 {
		t.Fatal("missing cookie accepted")
	}
	if w := post(s, cookie, "wrong", "preview", `{"code":"A"}`); w.Code != 403 {
		t.Fatal("invalid CSRF accepted")
	}
	r := httptest.NewRequest("GET", "http://site.test/api/session", nil)
	r.Header.Set("Origin", "https://attacker.test")
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("cross-origin bootstrap accepted")
	}
}

func TestIPHeadersRequireAllSwitchesAndTrustedPeer(t *testing.T) {
	s, _ := fixture(t)
	c := s.config
	c.TrustedProxy = []string{"10.0.0.0/8", "2001:db8::/32"}
	c.IPHeaders = []string{"X-Real-IP", "CF-Connecting-IP", "X-Forwarded-For"}
	c.EnabledIPHeaders = map[string]bool{"x-real-ip": true, "x-forwarded-for": true, "cf-connecting-ip": true}
	var err error
	s, err = New(c, s.store, s.adapter, s.assets)
	if err != nil {
		t.Fatal(err)
	}
	request := func(peer string, headers map[string]string) *http.Request {
		r := httptest.NewRequest("GET", "/", nil)
		r.RemoteAddr = peer
		for k, v := range headers {
			r.Header.Set(k, v)
		}
		return r
	}
	r := request("10.0.0.2:1234", map[string]string{"X-Real-IP": "203.0.113.7"})
	if got := s.clientIP(r); got != "10.0.0.2" {
		t.Fatal("master switch off was ignored")
	}
	s.config.TrustProxyHeaders = true
	if got := s.clientIP(r); got != "203.0.113.7" {
		t.Fatalf("X-Real-IP not honored: %s", got)
	}
	s.config.EnabledIPHeaders["x-real-ip"] = false
	if got := s.clientIP(r); got != "10.0.0.2" {
		t.Fatal("individual header switch off was ignored")
	}
	s.config.EnabledIPHeaders["x-real-ip"] = true
	if got := s.clientIP(request("198.51.100.1:5000", map[string]string{"X-Real-IP": "203.0.113.7"})); got != "198.51.100.1" {
		t.Fatal("untrusted client spoofed its IP")
	}
	if got := s.clientIP(request("10.0.0.2:5000", map[string]string{"X-Forwarded-For": "1.1.1.1, 203.0.113.8, 10.0.0.1"})); got != "203.0.113.8" {
		t.Fatalf("leftmost spoof accepted or chain incorrect: %s", got)
	}
	if got := s.clientIP(request("10.0.0.2:5000", map[string]string{"CF-Connecting-IP": "2001:4860::1"})); got != "2001:4860::1" {
		t.Fatal("IPv6 CF header not parsed")
	}
	if got := s.clientIP(request("10.0.0.2:5000", map[string]string{"X-Real-IP": "invalid", "X-Forwarded-For": "1.1.1.1"})); got != "10.0.0.2" {
		t.Fatal("malformed high-priority header must fail closed")
	}
}

func TestStaticFallbackAndNoCachingCredentials(t *testing.T) {
	s, _ := fixture(t)
	for _, item := range []struct {
		path string
		code int
	}{{"/redeem", 200}, {"/assets/missing.js", 404}, {"/api/missing", 404}} {
		w := httptest.NewRecorder()
		s.ServeHTTP(w, httptest.NewRequest("GET", item.path, nil))
		if w.Code != item.code {
			t.Errorf("%s returned %d", item.path, w.Code)
		}
	}
	cookie, csrf := session(t, s)
	w := post(s, cookie, csrf, "lookup", `{"code":"A"}`)
	if w.Header().Get("Cache-Control") != "no-store" || !strings.Contains(w.Header().Get("Content-Security-Policy"), "connect-src 'self'") {
		t.Fatal("missing security headers")
	}
	if !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode {
		t.Fatal("device cookie is not protected")
	}
}
