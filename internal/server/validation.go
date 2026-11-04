package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
)

type payload map[string]json.RawMessage

var fields = map[string][]string{
	"preview":        {"code"},
	"preflight":      {"code", "redemption_token", "credential"},
	"redeem":         {"redemption_token", "preflight_token", "credential", "client_request_id"},
	"result":         {"token"},
	"result-by-code": {"code"},
	"lookup":         {"code"},
	"lookup-batch":   {"codes", "text"},
	"billing":        {"token_input", "cdk_code", "system_id"},
}

func validate(raw []byte, operation string) (payload, error) {
	var p payload
	d := json.NewDecoder(bytes.NewReader(raw))
	if err := d.Decode(&p); err != nil || p == nil {
		return nil, errors.New("请求必须是 JSON 对象")
	}
	if d.Decode(new(any)) != io.EOF {
		return nil, errors.New("请求只能包含一个 JSON 对象")
	}
	allowed := map[string]bool{}
	for _, name := range fields[operation] {
		allowed[name] = true
	}
	for key := range p {
		if !allowed[key] {
			return nil, errors.New("请求包含不支持的字段")
		}
	}
	check := func(name string, max int, required bool) error {
		if _, exists := p[name]; !exists && !required {
			return nil
		}
		var v string
		if json.Unmarshal(p[name], &v) != nil || strings.TrimSpace(v) == "" || len(v) > max {
			return fmt.Errorf("%s 为空、格式不正确或超过长度限制", name)
		}
		return nil
	}
	for name, max := range map[string]int{"code": 256, "cdk_code": 256, "redemption_token": 2048, "token": 2048, "preflight_token": 65536, "client_request_id": 128, "token_input": 131072, "system_id": 64, "text": 32768} {
		if _, exists := p[name]; exists {
			if err := check(name, max, true); err != nil {
				return nil, err
			}
		}
	}
	if raw, exists := p["credential"]; exists {
		var credential struct {
			Mode    string `json:"mode"`
			Session string `json:"session"`
		}
		d := json.NewDecoder(bytes.NewReader(raw))
		d.DisallowUnknownFields()
		if d.Decode(&credential) != nil || credential.Mode != "session" || strings.TrimSpace(credential.Session) == "" || len(credential.Session) > 131072 {
			return nil, errors.New("credential 必须包含 session 模式及不超过 128 KiB 的完整凭证")
		}
	}
	required := map[string][]string{
		"preview": {"code"}, "lookup": {"code"}, "result-by-code": {"code"},
		"preflight": {"redemption_token", "credential"},
		"redeem":    {"redemption_token", "client_request_id"},
		"result":    {"token"},
	}
	for _, name := range required[operation] {
		if _, ok := p[name]; !ok {
			return nil, fmt.Errorf("缺少 %s", name)
		}
	}
	exclusive := func(a, b string) bool {
		_, aOK := p[a]
		_, bOK := p[b]
		return aOK != bOK
	}
	switch operation {
	case "redeem":
		if !exclusive("preflight_token", "credential") {
			return nil, errors.New("preflight_token 和 credential 必须二选一")
		}
	case "billing":
		if !exclusive("token_input", "cdk_code") || (p["cdk_code"] != nil && p["system_id"] != nil) {
			return nil, errors.New("请使用完整 Session 或卡密中的一种查询账单。")
		}
	case "lookup-batch":
		if !exclusive("codes", "text") {
			return nil, errors.New("codes 和 text 必须二选一")
		}
		var codes []string
		if p["codes"] != nil {
			if json.Unmarshal(p["codes"], &codes) != nil {
				return nil, errors.New("codes 必须为卡密字符串数组")
			}
		} else {
			codes = strings.Split(strings.ReplaceAll(p.text("text"), "\r\n", "\n"), "\n")
		}
		if len(codes) == 0 || len(codes) > 100 {
			return nil, errors.New("每次查询须包含 1 到 100 张卡密")
		}
		for i, code := range codes {
			codes[i] = strings.TrimSpace(code)
			if codes[i] == "" || len(codes[i]) > 256 {
				return nil, fmt.Errorf("第 %d 行卡密为空或过长", i+1)
			}
		}
		delete(p, "text")
		p.set("codes", codes)
	}
	return p, nil
}

func (p payload) text(key string) string {
	var value string
	_ = json.Unmarshal(p[key], &value)
	return value
}

func (p payload) set(key string, value any) {
	raw, _ := json.Marshal(value)
	p[key] = raw
}
