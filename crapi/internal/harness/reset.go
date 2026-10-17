package harness

import (
	"os"
	"path/filepath"
	"strings"
)

// ResetHarness 执行退回：优先还原最近一次备份；同时执行安全主动清理，彻底断开与 Crosery 网关的连接并恢复官方个人账号/直连状态。
func ResetHarness(e Env, h Harness, baseURL string) ([]string, error) {
	var changed []string
	cleanSkill(e, h)

	// 1. 如果有备份，先从最近一次备份恢复用户原始文件
	backups := ListBackups(h.ID())
	if len(backups) > 0 {
		restored, err := Restore(backups[0])
		if err == nil {
			changed = append(changed, restored...)
		}
	}

	// 2. 无论是否有备份，均执行二次主动清理，确保工具 100% 退出 Crosery 代理并恢复官方状态
	switch h.ID() {
	case "codex":
		p := e.P(".codex", "config.toml")
		if data, err := os.ReadFile(p); err == nil {
			d := ParseTOML(data)
			d.RemoveTablesWithPrefix("model_providers." + ProviderID)
			// 只动 crapi 自己写的 provider；用户自建的（如 custom）原样保留。
			if prov, _ := d.GetTop("model_provider"); UnquoteTOML(prov) == ProviderID {
				d.SetTop("model_provider", TOMLString("openai"))
			}
			if err := os.WriteFile(p, d.Bytes(), 0o600); err == nil {
				changed = append(changed, p)
			}
		}

	case "claude-code":
		p := e.P(".claude", "settings.json")
		if s, _, err := readJSONFile(p); err == nil && s != nil {
			env := s.Child("env")
			env.Delete("ANTHROPIC_BASE_URL")
			env.Delete("ANTHROPIC_AUTH_TOKEN")
			env.Delete("ANTHROPIC_DEFAULT_OPUS_MODEL")
			env.Delete("ANTHROPIC_DEFAULT_SONNET_MODEL")
			env.Delete("ANTHROPIC_DEFAULT_HAIKU_MODEL")
			if err := os.WriteFile(p, MarshalJSON(s), 0o600); err == nil {
				changed = append(changed, p)
			}
		}

	case "workbuddy":
		p := e.P(".workbuddy", "models.json")
		if data, err := os.ReadFile(p); err == nil {
			list := buddyList(data)
			var keep []any
			for _, v := range list {
				if o, ok := v.(*Obj); ok && baseMatches(o.Str("url"), baseURL) {
					continue
				}
				keep = append(keep, v)
			}
			if err := os.WriteFile(p, MarshalJSON(keep), 0o600); err == nil {
				changed = append(changed, p)
			}
		}
		sp := e.P(".workbuddy", "settings.json")
		if sf, _, err := readJSONFile(sp); err == nil && sf != nil {
			sf.Delete("model")
			sf.Delete("defaultModel")
			sf.Delete("selectedModel")
			_ = os.WriteFile(sp, MarshalJSON(sf), 0o644)
		}

	case "workbuddy-ai":
		p := e.P(".workbuddy-ai", "models.json")
		if data, err := os.ReadFile(p); err == nil {
			list := buddyList(data)
			var keep []any
			for _, v := range list {
				if o, ok := v.(*Obj); ok && baseMatches(o.Str("url"), baseURL) {
					continue
				}
				keep = append(keep, v)
			}
			if err := os.WriteFile(p, MarshalJSON(keep), 0o600); err == nil {
				changed = append(changed, p)
			}
		}
		sp := e.P(".workbuddy-ai", "settings.json")
		if sf, _, err := readJSONFile(sp); err == nil && sf != nil {
			sf.Delete("model")
			sf.Delete("defaultModel")
			sf.Delete("selectedModel")
			_ = os.WriteFile(sp, MarshalJSON(sf), 0o644)
		}

	case "opencode":
		p := e.P(".config", "opencode", "opencode.json")
		if s, _, err := readJSONFile(p); err == nil && s != nil {
			s.Child("provider").Delete(ProviderID)
			if strings.HasPrefix(s.Str("model"), ProviderID+"/") {
				s.Delete("model")
			}
			if err := os.WriteFile(p, MarshalJSON(s), 0o600); err == nil {
				changed = append(changed, p)
			}
		}

	case "kilo":
		p := e.P(".config", "kilo", "kilo.json")
		if s, _, err := readJSONFile(p); err == nil && s != nil {
			s.Child("provider").Delete(ProviderID)
			if strings.HasPrefix(s.Str("model"), ProviderID+"/") {
				s.Delete("model")
			}
			if err := os.WriteFile(p, MarshalJSON(s), 0o600); err == nil {
				changed = append(changed, p)
			}
		}

	case "kimi":
		p := e.P(".kimi-code", "config.toml")
		if data, err := os.ReadFile(p); err == nil {
			d := ParseTOML(data)
			d.RemoveTablesWithPrefix("providers." + ProviderID)
			d.RemoveTablesWithPrefix("models." + ProviderID)
			if err := os.WriteFile(p, d.Bytes(), 0o600); err == nil {
				changed = append(changed, p)
			}
		}

	case "hermes":
		p := e.P(".hermes", "config.yaml")
		if data, err := os.ReadFile(p); err == nil {
			doc, root, err := LoadYAML(data)
			if err == nil {
				if provs := YGet(root, "providers"); provs != nil {
					YDelete(provs, ProviderID)
				}
				if m := YGet(root, "model"); m != nil {
					if strings.Contains(YScalar(m, "provider"), ProviderID) {
						YDelete(m, "provider")
						YDelete(m, "default")
					}
				}
				if out, err := DumpYAML(doc); err == nil {
					_ = os.WriteFile(p, out, 0o600)
					changed = append(changed, p)
				}
			}
		}

	case "pi":
		mp := e.P(".pi", "agent", "models.json")
		if m, _, err := readJSONFile(mp); err == nil && m != nil {
			m.Child("providers").Delete(ProviderID)
			_ = os.WriteFile(mp, MarshalJSON(m), 0o600)
			changed = append(changed, mp)
		}
		sp := e.P(".pi", "agent", "settings.json")
		if s, _, err := readJSONFile(sp); err == nil && s != nil {
			if s.Str("defaultProvider") == ProviderID {
				s.Delete("defaultProvider")
				s.Delete("defaultModel")
				_ = os.WriteFile(sp, MarshalJSON(s), 0o600)
			}
		}

	case "qoder":
		p := e.P(".qoder", "settings.json")
		if s, _, err := readJSONFile(p); err == nil && s != nil {
			s.Child("providers").Delete(ProviderID)
			if strings.HasPrefix(s.Child("model").Str("name"), ProviderID+"/") {
				s.Child("model").Delete("name")
			}
			if err := os.WriteFile(p, MarshalJSON(s), 0o600); err == nil {
				changed = append(changed, p)
			}
		}

	case "qoder-cn":
		p := e.P(".qoder-cn", "settings.json")
		if s, _, err := readJSONFile(p); err == nil && s != nil {
			s.Child("providers").Delete(ProviderID)
			if strings.HasPrefix(s.Child("model").Str("name"), ProviderID+"/") {
				s.Child("model").Delete("name")
			}
			if err := os.WriteFile(p, MarshalJSON(s), 0o600); err == nil {
				changed = append(changed, p)
			}
		}

	case "gemini-cli":
		p := filepath.Join(e.P(".gemini"), ".env")
		if data, err := os.ReadFile(p); err == nil {
			out := SetDotenv(data, [][2]string{
				{"GOOGLE_GEMINI_BASE_URL", ""},
			})
			_ = os.WriteFile(p, out, 0o600)
			changed = append(changed, p)
		}
	}

	return changed, nil
}

func cleanSkill(e Env, h Harness) {
	for _, parent := range KnownSkillDirs(e) {
		crapiDir := filepath.Join(parent, "crapi")
		if fileExists(filepath.Join(crapiDir, "SKILL.md")) || dirExists(crapiDir) {
			_ = os.RemoveAll(crapiDir)
		}
	}
}
