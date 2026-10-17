package harness

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/crosery/crapi/internal/store"
)

// Env 是 harness 探测与写配置时依赖的环境。测试时可指向临时目录。
type Env struct {
	Home string
	GOOS string
}

// DefaultEnv 返回当前用户的环境。
func DefaultEnv() Env {
	home, _ := os.UserHomeDir()
	return Env{Home: home, GOOS: runtime.GOOS}
}

// P 拼接 home 下的路径。
func (e Env) P(parts ...string) string { return filepath.Join(append([]string{e.Home}, parts...)...) }

// AppData 返回 Windows 的 %APPDATA%（Roaming），其余平台返回 ~/.config。
func (e Env) AppData() string {
	if e.GOOS == "windows" {
		if d := os.Getenv("APPDATA"); d != "" && e.Home == defaultHome() {
			return d
		}
		return e.P("AppData", "Roaming")
	}
	if d := os.Getenv("XDG_CONFIG_HOME"); d != "" && e.Home == defaultHome() {
		return d
	}
	return e.P(".config")
}

// LocalAppData 返回 Windows 的 %LOCALAPPDATA%。
func (e Env) LocalAppData() string {
	if d := os.Getenv("LOCALAPPDATA"); d != "" && e.Home == defaultHome() {
		return d
	}
	return e.P("AppData", "Local")
}

// AppSupport 返回桌面应用的用户数据根目录：
// macOS ~/Library/Application Support，Windows %APPDATA%，Linux ~/.config。
func (e Env) AppSupport() string {
	switch e.GOOS {
	case "darwin":
		return e.P("Library", "Application Support")
	default:
		return e.AppData()
	}
}

func defaultHome() string { h, _ := os.UserHomeDir(); return h }

// Writer 负责写配置：首次改动某文件前先备份，写入走「临时文件 + rename」。
// DryRun 时只记录不落盘。
type Writer struct {
	DryRun  bool
	Harness string
	stamp   string
	written []string
	backups map[string]string
}

// NewWriter 为一次运行创建 writer；同一次运行的备份放在同一个时间戳目录下。
func NewWriter(dryRun bool, stamp string) *Writer {
	if stamp == "" {
		stamp = time.Now().Format("20060102-150405")
	}
	return &Writer{DryRun: dryRun, stamp: stamp, backups: map[string]string{}}
}

// Written 返回本次写过的文件。
func (w *Writer) Written() []string { return append([]string(nil), w.written...) }

// Write 写文件（保留原文件权限，新文件用 perm）。内容未变化时跳过。
func (w *Writer) Write(path string, data []byte, perm os.FileMode) error {
	old, err := os.ReadFile(path)
	exists := err == nil
	if exists && bytes.Equal(old, data) {
		return nil
	}
	w.written = append(w.written, path)
	if w.DryRun {
		return nil
	}
	if exists {
		if err := w.backup(path, old); err != nil {
			return fmt.Errorf("备份 %s 失败：%w", path, err)
		}
		if st, err := os.Stat(path); err == nil {
			perm = st.Mode().Perm()
		}
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".crapi-tmp"
	if err := os.WriteFile(tmp, data, perm); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		if runtime.GOOS == "windows" {
			return fmt.Errorf("写入 %s 失败（文件可能被正在运行的程序占用，关掉它再试）：%w", path, err)
		}
		return err
	}
	return nil
}

// backup 把原文件复制到 backups/<时间戳>/<harness>/，并记入 index.json 以便 restore。
func (w *Writer) backup(path string, data []byte) error {
	if _, done := w.backups[path]; done {
		return nil
	}
	dir := filepath.Join(store.BackupDir(), w.stamp, w.Harness)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	name := sanitize(path)
	dst := filepath.Join(dir, name)
	if err := os.WriteFile(dst, data, 0o600); err != nil {
		return err
	}
	w.backups[path] = dst
	idx := readIndex(dir)
	idx[name] = path
	buf, _ := json.MarshalIndent(idx, "", "  ")
	return os.WriteFile(filepath.Join(dir, "index.json"), buf, 0o600)
}

func sanitize(p string) string {
	r := strings.NewReplacer(string(filepath.Separator), "__", ":", "", "/", "__")
	return strings.TrimLeft(r.Replace(p), "_")
}

func readIndex(dir string) map[string]string {
	idx := map[string]string{}
	if b, err := os.ReadFile(filepath.Join(dir, "index.json")); err == nil {
		_ = json.Unmarshal(b, &idx)
	}
	return idx
}

// Backup 是一次可恢复的备份。
type Backup struct {
	Stamp   string
	Harness string
	Files   map[string]string // 备份文件 -> 原路径
}

// ListBackups 按时间倒序列出某个 harness 的备份（harness 为空时列出全部）。
func ListBackups(harness string) []Backup {
	root := store.BackupDir()
	stamps, _ := os.ReadDir(root)
	var out []Backup
	for _, s := range stamps {
		if !s.IsDir() {
			continue
		}
		hs, _ := os.ReadDir(filepath.Join(root, s.Name()))
		for _, h := range hs {
			if !h.IsDir() || (harness != "" && h.Name() != harness) {
				continue
			}
			dir := filepath.Join(root, s.Name(), h.Name())
			files := map[string]string{}
			for name, orig := range readIndex(dir) {
				files[filepath.Join(dir, name)] = orig
			}
			if len(files) > 0 {
				out = append(out, Backup{Stamp: s.Name(), Harness: h.Name(), Files: files})
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Stamp > out[j].Stamp })
	return out
}

// Restore 把备份写回原路径。
func Restore(b Backup) ([]string, error) {
	var restored []string
	for src, dst := range b.Files {
		data, err := os.ReadFile(src)
		if err != nil {
			return restored, err
		}
		perm := fs.FileMode(0o600)
		if st, err := os.Stat(dst); err == nil {
			perm = st.Mode().Perm()
		}
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return restored, err
		}
		if err := os.WriteFile(dst, data, perm); err != nil {
			return restored, err
		}
		restored = append(restored, dst)
	}
	return restored, nil
}

// readJSONFile 读取并解析 JSON/JSONC 对象文件；不存在时返回空对象。
func readJSONFile(path string) (*Obj, bool, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return NewObj(), false, nil
	}
	if err != nil {
		return nil, false, err
	}
	o, had, err := ParseJSON(data)
	if err != nil {
		return nil, false, fmt.Errorf("%s 不是合法 JSON：%w", path, err)
	}
	return o, had, nil
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

func dirExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
}
