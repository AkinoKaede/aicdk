package config

import "testing"

func TestRouting(t *testing.T) {
	c := Config{Default: "a", Systems: []System{
		{ID: "a", Prefixes: []string{"A-"}},
		{ID: "b", Prefixes: []string{"B-"}, StripPrefix: true},
		{ID: "c", Prefixes: []string{"B-LONG-"}, StripPrefix: true},
	}}
	for _, test := range []struct{ input, system, code string }{
		{"A-123", "a", "A-123"}, {"b-123", "b", "123"}, {" B-long-AbC ", "c", "AbC"},
		{"UNKNOWN-1", "a", "UNKNOWN-1"},
	} {
		system, code, err := c.Match(test.input)
		if err != nil || system.ID != test.system || code != test.code {
			t.Errorf("match %q = %s/%s/%v", test.input, system.ID, code, err)
		}
	}
	c.Default = ""
	if _, _, err := c.Match("unknown"); err == nil {
		t.Fatal("unmatched code must fail without a default")
	}
	if _, _, err := c.Match("B-"); err == nil {
		t.Fatal("empty stripped code must fail")
	}
}

func TestValidateRejectsUnsafeConfig(t *testing.T) {
	for _, baseURL := range []string{"http://example.com", "https://user:pass@example.com", "https://example.com/path", "https://example.com?password=x", "https://example.com#secret"} {
		c := Config{Systems: []System{{ID: "a", BaseURL: baseURL, PasswordEnv: "PASS"}}}
		if err := c.Validate(func(string) string { return "secret" }); err == nil {
			t.Errorf("accepted invalid base URL: %s", baseURL)
		}
	}
	c := Config{Systems: []System{
		{ID: "a", BaseURL: "https://one.test", PasswordEnv: "PASS", Prefixes: []string{"abc-"}},
		{ID: "b", BaseURL: "https://two.test", PasswordEnv: "PASS", Prefixes: []string{"ABC-"}},
	}}
	if err := c.Validate(func(string) string { return "secret" }); err == nil {
		t.Fatal("duplicate prefix accepted")
	}
}

func TestProxyHeaderSwitches(t *testing.T) {
	t.Setenv("CONFIG_FILE", "")
	t.Setenv("PUBLIC_ORIGIN", "")
	t.Setenv("CDK_PARTNER_PASSWORD", "test-password")
	t.Setenv("TRUST_PROXY_HEADERS", "false")
	t.Setenv("TRUST_X_REAL_IP", "true")
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.TrustProxyHeaders || !c.EnabledIPHeaders["x-real-ip"] {
		t.Fatal("switches were not loaded independently")
	}
	t.Setenv("TRUST_PROXY_HEADERS", "not-a-boolean")
	if _, err := Load(); err == nil {
		t.Fatal("invalid boolean accepted")
	}
}
