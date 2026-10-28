package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
)

type RuleTemplate struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Smart   bool     `json:"smart"`
	Rules   []string `json:"rules"`
	Builtin bool     `json:"builtin"`
}

func builtinTemplates() []RuleTemplate {
	return []RuleTemplate{
		{ID: "basic-v1", Name: "基础直连与境外代理", Builtin: true, Rules: []string{"GEOIP,LAN,DIRECT", "GEOIP,CN,DIRECT", "MATCH,节点选择"}},
		{ID: "smart-v1", Name: "日常分流 · AI / Telegram / 流媒体", Builtin: true, Smart: true, Rules: []string{"RULE-SET,private,DIRECT", "RULE-SET,openai,AI", "RULE-SET,telegram,Telegram", "RULE-SET,youtube,流媒体", "RULE-SET,github,节点选择", "RULE-SET,cn,DIRECT", "GEOIP,CN,DIRECT,no-resolve", "MATCH,节点选择"}},
	}
}

func (a *App) ruleTemplates() []RuleTemplate {
	out := builtinTemplates()
	for _, raw := range a.list("rule_template") {
		var v RuleTemplate
		if json.Unmarshal(raw, &v) == nil {
			v.Builtin = false
			out = append(out, v)
		}
	}
	return out
}
func (a *App) ruleTemplate(id string) (RuleTemplate, error) {
	for _, v := range a.ruleTemplates() {
		if v.ID == id {
			return v, nil
		}
	}
	return RuleTemplate{}, errors.New("分流模板不存在")
}

func writeSmartNetwork(b *bytes.Buffer) {
	// Redir-host resolves real IPs. Client DNS has no relation to DNS/CDN proxying of VPS records.
	dns := map[string]any{"enable": true, "ipv6": true, "enhanced-mode": "redir-host", "default-nameserver": []string{"223.5.5.5", "1.1.1.1"}, "nameserver": []string{"https://dns.alidns.com/dns-query", "https://1.1.1.1/dns-query"}, "proxy-server-nameserver": []string{"https://dns.alidns.com/dns-query"}}
	fmt.Fprintf(b, "dns: %s\n", yamlValue(dns))
	providers := map[string]any{}
	for _, name := range []string{"private", "cn", "openai", "telegram", "youtube", "github"} {
		providers[name] = map[string]any{"type": "http", "behavior": "domain", "format": "mrs", "path": "./ruleset/subhub-" + name + ".mrs", "url": "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geosite/" + name + ".mrs", "interval": 86400}
	}
	fmt.Fprintf(b, "rule-providers: %s\n", yamlValue(providers))
}

func (a *App) renderProfileClash(nodes []Node, p Profile) ([]byte, error) {
	if p.TemplateID == "" {
		return renderClash(nodes, p.Rules), nil
	}
	t, err := a.ruleTemplate(p.TemplateID)
	if err != nil {
		return nil, err
	}
	rules := []string{}
	fallback := "MATCH,节点选择"
	hasFallback := false
	// Per-profile exceptions precede the reusable template. Only one final MATCH.
	for _, rule := range append(append([]string{}, p.Rules...), t.Rules...) {
		if strings.HasPrefix(rule, "MATCH,") {
			if !hasFallback {
				fallback = rule
				hasFallback = true
			}
			continue
		}
		rules = append(rules, rule)
	}
	rules = append(rules, fallback)
	return renderClashTemplate(nodes, rules, t.Smart), nil
}

func validateRuleTemplate(v RuleTemplate) error {
	if !recordIDPattern.MatchString(v.ID) || strings.TrimSpace(v.Name) == "" || len(v.Name) > 160 || len(v.Rules) > 500 {
		return errors.New("模板名称或规则数量不合法")
	}
	for _, rule := range v.Rules {
		if len(rule) > 2048 || strings.ContainsAny(rule, "\r\n\x00") || !strings.Contains(rule, ",") {
			return errors.New("请每行填写一条有效分流规则")
		}
		parts := strings.Split(rule, ",")
		for _, part := range parts {
			if part == "" || part != strings.TrimSpace(part) {
				return errors.New("规则字段不可为空或包含首尾空格")
			}
		}
		kind := parts[0]
		if !containsID([]string{"DOMAIN", "DOMAIN-SUFFIX", "DOMAIN-KEYWORD", "IP-CIDR", "IP-CIDR6", "GEOIP", "RULE-SET", "MATCH"}, kind) {
			return errors.New("不支持的模板规则类型")
		}
		count := 3
		if kind == "MATCH" {
			count = 2
		}
		if len(parts) == count+1 && parts[count] == "no-resolve" && (kind == "IP-CIDR" || kind == "IP-CIDR6" || kind == "GEOIP") {
			parts = parts[:count]
		}
		if len(parts) != count {
			return errors.New("规则参数数量不正确")
		}
		allowed := []string{"DIRECT", "REJECT", "节点选择", "自动选择", "故障转移"}
		if v.Smart {
			allowed = append(allowed, "AI", "Telegram", "流媒体")
		}
		if !containsID(allowed, parts[count-1]) {
			return errors.New("规则引用了未提供的策略组")
		}
		if kind == "RULE-SET" && (!v.Smart || !containsID([]string{"private", "cn", "openai", "telegram", "youtube", "github"}, parts[1])) {
			return errors.New("规则引用了未提供的规则集")
		}
	}
	return nil
}

func (a *App) templatesAPI(w http.ResponseWriter, r *http.Request, path string) bool {
	if path == "rule-templates" && r.Method == "GET" {
		writeJSON(w, 200, a.ruleTemplates())
		return true
	}
	if !strings.HasPrefix(path, "rule-templates/") {
		return false
	}
	id := strings.TrimPrefix(path, "rule-templates/")
	for _, v := range builtinTemplates() {
		if id == v.ID {
			apiError(w, 409, "内置模板不可修改，请另存为自定义模板")
			return true
		}
	}
	switch r.Method {
	case "PUT":
		var v RuleTemplate
		if decodeBody(r, &v) != nil || v.ID != "" && v.ID != id {
			apiError(w, 400, "模板请求无效")
			return true
		}
		v.ID, v.Builtin = id, false
		if err := validateRuleTemplate(v); err != nil {
			apiError(w, 400, err.Error())
			return true
		}
		if a.put("rule_template", id, v) != nil {
			apiError(w, 500, "保存失败")
			return true
		}
		a.audit("rule-template.save", id)
		writeJSON(w, 200, v)
	case "DELETE":
		for _, raw := range a.list("profile") {
			var p Profile
			json.Unmarshal(raw, &p)
			if p.TemplateID == id {
				apiError(w, 409, "模板仍被订阅引用")
				return true
			}
		}
		if _, err := a.db.Exec("DELETE FROM records WHERE kind='rule_template' AND id=?", id); err != nil {
			apiError(w, 500, "删除失败")
			return true
		}
		a.audit("rule-template.delete", id)
		writeJSON(w, 200, map[string]bool{"ok": true})
	default:
		apiError(w, 405, "method not allowed")
	}
	return true
}
