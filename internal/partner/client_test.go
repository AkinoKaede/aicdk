package partner

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"cdk/internal/config"
)

func TestAuthenticationAndDevice(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, password, ok := r.BasicAuth()
		if !ok || user != "partner" || password != "test-password" || r.Header.Get("X-Redemption-Device") != "device-1234567890" || r.URL.Path != "/api/partner/v1/preview" {
			t.Error("request was not authenticated or routed correctly")
		}
		w.Write([]byte(`{"ok":true,"data":{"product":"gpt"}}`))
	}))
	defer upstream.Close()
	client := New()
	reply, status := client.Call(context.Background(), config.System{BaseURL: upstream.URL, Password: "test-password"}, "preview", "device-1234567890", []byte(`{"code":"one"}`))
	if !reply.OK || status != 200 {
		t.Fatalf("unexpected response: %v %d", reply, status)
	}
}

func TestUncertainAndNoRetries(t *testing.T) {
	for _, test := range []struct {
		name, body string
		status     int
		uncertain  bool
	}{
		{"html gateway", "<h1>bad gateway</h1>", 502, true},
		{"malformed accepted", "not-json", 200, true},
		{"rate limit", "slow down", 429, false},
		{"upstream error", `{"ok":false,"error":{"code":"FAIL","message":"no","retryable":true}}`, 503, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			var calls atomic.Int32
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				calls.Add(1)
				w.WriteHeader(test.status)
				w.Write([]byte(test.body))
			}))
			defer upstream.Close()
			reply, _ := New().Call(context.Background(), config.System{BaseURL: upstream.URL, Password: "secret"}, "redeem", "device-1234567890", []byte(`{}`))
			if reply.OK || reply.Error == nil || reply.Error.Uncertain != test.uncertain || calls.Load() != 1 {
				t.Fatalf("unexpected retry or certainty: %+v, calls %d", reply, calls.Load())
			}
		})
	}
}

func TestNoRedirectAndRedactedErrors(t *testing.T) {
	var destinationCalls atomic.Int32
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { destinationCalls.Add(1) }))
	defer destination.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, destination.URL, 307) }))
	defer redirect.Close()
	reply, status := New().Call(context.Background(), config.System{BaseURL: redirect.URL, Password: "secret"}, "redeem", "device-1234567890", []byte(`{}`))
	if destinationCalls.Load() != 0 || !reply.Error.Uncertain || status != 502 {
		t.Fatal("redirect was followed or uncertain flag missing")
	}
	message := redact("test-password MY-CODE-123 credential-secret", "test-password", []byte(`{"code":"MY-CODE-123","credential":{"session":"credential-secret"}}`))
	if strings.Contains(message, "secret") || strings.Contains(message, "MY-CODE-123") || strings.Contains(message, "test-password") {
		t.Fatal("error contains credentials")
	}
}

func TestSubmissionTimeout(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(100 * time.Millisecond):
		}
	}))
	defer upstream.Close()
	client := New()
	client.RedeemTimeout = 20 * time.Millisecond
	reply, _ := client.Call(context.Background(), config.System{BaseURL: upstream.URL, Password: "secret"}, "redeem", "device-1234567890", []byte(`{}`))
	if !reply.Error.Uncertain {
		raw, _ := json.Marshal(reply)
		t.Fatalf("timeout is not uncertain: %s", raw)
	}
}
