package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

type System struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Adapter     string   `json:"adapter"`
	BaseURL     string   `json:"base_url"`
	PasswordEnv string   `json:"password_env"`
	Prefixes    []string `json:"prefixes"`
	StripPrefix bool     `json:"strip_prefix"`
	Password    string   `json:"-"`
}

type Config struct {
	Listen            string          `json:"-"`
	DataDir           string          `json:"-"`
	PublicOrigin      string          `json:"-"`
	Default           string          `json:"default_system"`
	Systems           []System        `json:"systems"`
	TrustedProxy      []string        `json:"-"`
	IPHeaders         []string        `json:"-"`
	TrustProxyHeaders bool            `json:"-"`
	EnabledIPHeaders  map[string]bool `json:"-"`
}

func Load() (Config, error) {
	c := Config{
		Listen: env("LISTEN_ADDR", ":8080"), DataDir: env("DATA_DIR", "./data"),
		PublicOrigin: strings.TrimRight(os.Getenv("PUBLIC_ORIGIN"), "/"),
	}
	if path := os.Getenv("CONFIG_FILE"); path != "" {
		f, err := os.Open(path)
		if err != nil {
			return c, fmt.Errorf("open config: %w", err)
		}
		defer f.Close()
		d := json.NewDecoder(io.LimitReader(f, 1<<20))
		d.DisallowUnknownFields()
		if err := d.Decode(&c); err != nil {
			return c, fmt.Errorf("decode config: %w", err)
		}
		if err := d.Decode(new(any)); err != io.EOF {
			return c, errors.New("config must contain exactly one JSON object")
		}
	} else {
		c.Default = "primary"
		c.Systems = []System{{
			ID: "primary", Name: "默认兑换系统", Adapter: "partner-v1",
			BaseURL: env("CDK_UPSTREAM_URL", "https://cdk.bar"), PasswordEnv: "CDK_PARTNER_PASSWORD",
		}}
	}
	if c.PublicOrigin != "" {
		u, err := url.Parse(c.PublicOrigin)
		if err != nil || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || (u.Scheme != "https" && u.Scheme != "http") {
			return c, errors.New("PUBLIC_ORIGIN must be an HTTP(S) origin without a path")
		}
	}
	if raw := os.Getenv("TRUSTED_PROXY_CIDRS"); raw != "" {
		for _, value := range strings.Split(raw, ",") {
			c.TrustedProxy = append(c.TrustedProxy, strings.TrimSpace(value))
		}
	}
	c.IPHeaders = strings.Split(env("CLIENT_IP_HEADERS", "X-Forwarded-For,X-Real-IP,CF-Connecting-IP,True-Client-IP"), ",")
	for i, header := range c.IPHeaders {
		c.IPHeaders[i] = strings.TrimSpace(header)
	}
	trust, err := strconv.ParseBool(env("TRUST_PROXY_HEADERS", "false"))
	if err != nil {
		return c, errors.New("TRUST_PROXY_HEADERS must be true or false")
	}
	c.TrustProxyHeaders = trust
	c.EnabledIPHeaders = map[string]bool{}
	for header, key := range map[string]string{
		"x-forwarded-for": "TRUST_X_FORWARDED_FOR", "x-real-ip": "TRUST_X_REAL_IP",
		"cf-connecting-ip": "TRUST_CF_CONNECTING_IP", "true-client-ip": "TRUST_TRUE_CLIENT_IP",
	} {
		fallback := "false"
		if header == "x-forwarded-for" {
			fallback = "true"
		}
		enabled, err := strconv.ParseBool(env(key, fallback))
		if err != nil {
			return c, fmt.Errorf("%s must be true or false", key)
		}
		c.EnabledIPHeaders[header] = enabled
	}
	return c, c.Validate(os.Getenv)
}

func (c *Config) Validate(getenv func(string) string) error {
	if len(c.Systems) == 0 || len(c.Systems) > 32 {
		return errors.New("configure between 1 and 32 upstream systems")
	}
	ids, prefixes := map[string]bool{}, map[string]bool{}
	for i := range c.Systems {
		s := &c.Systems[i]
		if !validID(s.ID) || ids[s.ID] {
			return errors.New("system IDs must be unique ASCII identifiers")
		}
		ids[s.ID] = true
		if s.Name == "" {
			s.Name = s.ID
		}
		if s.Adapter == "" {
			s.Adapter = "partner-v1"
		}
		if s.Adapter != "partner-v1" {
			return fmt.Errorf("system %s: unsupported adapter", s.ID)
		}
		u, err := url.Parse(s.BaseURL)
		if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
			return fmt.Errorf("system %s: base_url must be an HTTPS origin", s.ID)
		}
		s.BaseURL = strings.TrimRight(s.BaseURL, "/")
		s.Password = getenv(s.PasswordEnv)
		if s.PasswordEnv == "" || s.Password == "" || len(s.Password) > 1024 {
			return fmt.Errorf("system %s: missing or invalid password in environment variable %s", s.ID, s.PasswordEnv)
		}
		for j, prefix := range s.Prefixes {
			p := strings.ToUpper(strings.TrimSpace(prefix))
			if p == "" || len(p) > 64 || prefixes[p] {
				return fmt.Errorf("system %s: prefixes must be nonempty and globally unique", s.ID)
			}
			for _, r := range p {
				if !((r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_') {
					return fmt.Errorf("system %s: prefixes must use ASCII letters, digits, - or _", s.ID)
				}
			}
			prefixes[p] = true
			s.Prefixes[j] = p
		}
	}
	if c.Default != "" && !ids[c.Default] {
		return errors.New("default_system does not exist")
	}
	return nil
}

// Match uses the longest prefix, independent of config ordering.
func (c Config) Match(code string) (System, string, error) {
	code = strings.TrimSpace(code)
	normalized, best, selected := strings.ToUpper(code), "", -1
	for i, s := range c.Systems {
		for _, prefix := range s.Prefixes {
			if strings.HasPrefix(normalized, prefix) && len(prefix) > len(best) {
				best, selected = prefix, i
			}
		}
	}
	if selected < 0 {
		for i, s := range c.Systems {
			if s.ID == c.Default {
				selected = i
				break
			}
		}
	}
	if selected < 0 {
		return System{}, "", errors.New("无法识别这张卡密，请核对完整卡密或联系发卡方。")
	}
	s := c.Systems[selected]
	if s.StripPrefix && best != "" {
		code = code[len(best):]
	}
	if strings.TrimSpace(code) == "" {
		return System{}, "", errors.New("卡密不完整，请输入收到的完整卡密。")
	}
	return s, code, nil
}

func validID(value string) bool {
	if len(value) == 0 || len(value) > 64 {
		return false
	}
	for _, r := range value {
		if !((r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_' || r == '-') {
			return false
		}
	}
	return true
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

const QueryTimeout = 125 * time.Second
const RedeemTimeout = 155 * time.Second
