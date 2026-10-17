// Package store 保存 crapi 自己的配置：API Key、服务地址、已接管的 harness 与备份索引。
// 位置：macOS/Linux 为 $XDG_CONFIG_HOME/crapi（缺省 ~/.config/crapi），Windows 为 %APPDATA%\crapi。
// 文件权限 0600；Key 只写在这里和各 harness 自己的配置文件里，不进日志。
package store

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const (
	DefaultBaseURL    = "https://ai.crosery.com"
	DefaultConsoleURL = "https://console.ai.crosery.com"
)

// Managed 记录某个 harness 被 crapi 配置过的情况，update 时据此刷新。
type Managed struct {
	ConfiguredAt time.Time `json:"configuredAt"`
	UpdatedAt    time.Time `json:"updatedAt,omitzero"`
	Model        string    `json:"model,omitempty"`
	Files        []string  `json:"files,omitempty"`
}

// Config 是 crapi 的持久化配置。
type Config struct {
	APIKey          string             `json:"apiKey,omitempty"`
	BaseURL         string             `json:"baseUrl,omitempty"`
	ConsoleURL      string             `json:"consoleUrl,omitempty"`
	DefaultModel    string             `json:"defaultModel,omitempty"`
	Managed         map[string]Managed `json:"managed,omitempty"`
	LastUpdate      time.Time          `json:"lastUpdate,omitzero"`
	LastCheckUpdate time.Time          `json:"lastCheckUpdate,omitzero"`
	LatestVersion   string             `json:"latestVersion,omitempty"`
	ModelIDs        []string           `json:"modelIds,omitempty"` // 上次同步时的模型列表，用于 update 对比增减
}

// Dir 返回 crapi 的配置目录。
func Dir() string {
	if d := os.Getenv("CRAPI_HOME"); d != "" {
		return d
	}
	if runtime.GOOS == "windows" {
		if d := os.Getenv("APPDATA"); d != "" {
			return filepath.Join(d, "crapi")
		}
	}
	if d := os.Getenv("XDG_CONFIG_HOME"); d != "" {
		return filepath.Join(d, "crapi")
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "crapi")
}

// Path 返回配置文件路径。
func Path() string { return filepath.Join(Dir(), "config.json") }

// BackupDir 返回备份根目录。
func BackupDir() string { return filepath.Join(Dir(), "backups") }

// Load 读取配置；文件不存在时返回空配置。环境变量优先于文件。
func Load() (*Config, error) {
	c := &Config{}
	data, err := os.ReadFile(Path())
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if len(data) > 0 {
		if err := json.Unmarshal(trimBOM(data), c); err != nil {
			return nil, err
		}
	}
	if c.Managed == nil {
		c.Managed = map[string]Managed{}
	}
	return c, nil
}

// Base 返回生效的网关地址：CRAPI_BASE_URL > 配置文件 > 默认值。
func (c *Config) Base() string {
	return strings.TrimRight(firstNonEmpty(os.Getenv("CRAPI_BASE_URL"), c.BaseURL, DefaultBaseURL), "/")
}

// Console 返回生效的控制台地址：CRAPI_CONSOLE_URL > 配置文件 > 默认值。
func (c *Config) Console() string {
	return strings.TrimRight(firstNonEmpty(os.Getenv("CRAPI_CONSOLE_URL"), c.ConsoleURL, DefaultConsoleURL), "/")
}

func firstNonEmpty(vs ...string) string {
	for _, v := range vs {
		if v = strings.TrimSpace(v); v != "" {
			return v
		}
	}
	return ""
}

// Key 返回生效的 API Key：环境变量 CRAPI_KEY 优先。
func (c *Config) Key() string {
	if v := strings.TrimSpace(os.Getenv("CRAPI_KEY")); v != "" {
		return v
	}
	return c.APIKey
}

// Save 原子写入配置文件（0600）。
func (c *Config) Save() error {
	if err := os.MkdirAll(Dir(), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	tmp := Path() + ".tmp"
	if err := os.WriteFile(tmp, append(data, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, Path())
}

func trimBOM(b []byte) []byte {
	if len(b) >= 3 && b[0] == 0xEF && b[1] == 0xBB && b[2] == 0xBF {
		return b[3:]
	}
	return b
}

// MaskKey 只保留首尾少量字符，用于展示。
func MaskKey(k string) string {
	if len(k) <= 10 {
		return strings.Repeat("*", len(k))
	}
	return k[:6] + strings.Repeat("*", 6) + k[len(k)-4:]
}
