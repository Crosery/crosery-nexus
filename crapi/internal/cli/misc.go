package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/crosery/crapi/internal/api"
	"github.com/crosery/crapi/internal/harness"
	"github.com/crosery/crapi/internal/store"
	"github.com/crosery/crapi/internal/term"
	"github.com/crosery/crapi/internal/ui"
)

// ---------- status ----------

const statusHelp = `crapi status [--json]

列出 crapi 支持的全部 harness：是否已安装、是否已接入 crosery、当前默认模型。`

func cmdStatus(a *App, args []string) error {
	fs := newFlags("status", statusHelp)
	asJSON := fs.Bool("json", false, "")
	if _, err := parse(fs, args, statusHelp); err != nil {
		return err
	}
	env := harness.DefaultEnv()
	type item struct {
		ID         string `json:"id"`
		Name       string `json:"name"`
		Category   string `json:"category"`
		Installed  bool   `json:"installed"`
		Where      string `json:"where,omitempty"`
		Configured bool   `json:"configured"`
		Model      string `json:"model,omitempty"`
	}
	var items []item
	for _, h := range harness.All() {
		d := h.Detect(env)
		it := item{ID: h.ID(), Name: h.Name(), Category: string(h.Category()), Installed: d.Installed, Where: d.Where}
		if d.Installed {
			st := h.Status(env, a.Cfg.Base())
			it.Configured, it.Model = st.Configured, st.Model
		}
		items = append(items, it)
	}
	if *asJSON {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(items)
	}
	g := ui.G()
	installed, configured := 0, 0
	var rows [][]string
	for _, it := range items {
		inst := ui.Dim.Render("-")
		if it.Installed {
			inst = ui.OKS.Render(g.OK)
			installed++
		}
		conf := ui.Dim.Render("-")
		if it.Configured {
			conf = ui.AccentS.Render(g.Dot + " 已接入")
			configured++
		} else if it.Installed {
			conf = ui.WarnS.Render("未接入")
		}
		rows = append(rows, []string{it.Name, it.ID, it.Category, inst, conf, ui.Truncate(it.Model, 30)})
	}
	ui.Section("Harness 接入状态", fmt.Sprintf("支持 %d 个 · 已安装 %d · 已接入 %d", len(items), installed, configured))
	ui.Println(indent(ui.Table([]string{"名称", "标识", "类型", "安装", "Crosery", "默认模型"}, rows,
		ui.Left, ui.Left, ui.Left, ui.Center, ui.Left, ui.Left), "  "))
	ui.Println()
	ui.Note("接入未接入的：crapi setup <标识>；同步最新模型：crapi update")
	return nil
}

// ---------- key ----------

const keyHelp = `crapi key [set|show|clear] [sk-xxx]

  crapi key            查看当前 Key（打码）与有效性
  crapi key set sk-xx  更换 Key（会校验），之后运行 crapi update 同步到各 harness
  crapi key clear      从本机删除 Key`

func cmdKey(a *App, args []string) error {
	fs := newFlags("key", keyHelp)
	pos, err := parse(fs, args, keyHelp)
	if err != nil {
		return err
	}
	sub := "show"
	if len(pos) > 0 {
		sub = pos[0]
	}
	switch sub {
	case "show":
		k := a.Cfg.Key()
		if k == "" {
			ui.Warn("还没有设置 API Key，运行 crapi key set 或 crapi setup")
			return nil
		}
		ui.KV("API Key", store.MaskKey(k))
		ui.KV("保存位置", store.Path())
		c := a.clientWith(k)
		models, err := a.fetchModels(c)
		if err != nil {
			ui.Fail("校验失败：%v", err)
			return nil
		}
		ui.KV("状态", ui.OKS.Render("有效")+ui.Dim.Render(fmt.Sprintf(" · 可用 %d 个模型", len(models))))
	case "set", "login":
		flagKey := ""
		if len(pos) > 1 {
			flagKey = pos[1]
		}
		old := a.Cfg.APIKey
		a.Cfg.APIKey = ""
		if _, _, err := a.ensureKey(flagKey, true); err != nil {
			a.Cfg.APIKey = old
			return err
		}
		if len(a.Cfg.Managed) > 0 {
			ui.Note("已接入的 harness 仍在使用旧 Key，运行 crapi update 同步新 Key")
		}
	case "clear", "logout":
		a.Cfg.APIKey = ""
		if err := a.Cfg.Save(); err != nil {
			return err
		}
		ui.Success("已从 crapi 配置中删除 Key（各 harness 里的配置未改动）")
	default:
		ui.Println(keyHelp)
	}
	return nil
}

// ---------- restore ----------

const restoreHelp = `crapi restore [harness] [--list]

把某个 harness 的配置文件恢复到 crapi 修改前的样子（使用最近一次备份）。
  --list   列出全部备份`

func cmdRestore(a *App, args []string) error {
	fs := newFlags("restore", restoreHelp)
	listOnly := fs.Bool("list", false, "")
	pos, err := parse(fs, args, restoreHelp)
	if err != nil {
		return err
	}
	target := ""
	if len(pos) > 0 {
		h, ok := harness.Get(pos[0])
		if !ok {
			return fmt.Errorf("不认识的 harness：%s", pos[0])
		}
		target = h.ID()
	}
	backups := harness.ListBackups(target)
	if len(backups) == 0 {
		ui.Warn("没有找到备份（%s）", store.BackupDir())
		return nil
	}
	if *listOnly || target == "" {
		ui.Section("配置备份", store.BackupDir())
		var rows [][]string
		for _, b := range backups {
			var files []string
			for _, orig := range b.Files {
				files = append(files, orig)
			}
			rows = append(rows, []string{b.Stamp, b.Harness, ui.Truncate(strings.Join(files, ", "), 70)})
		}
		ui.Println(indent(ui.Table([]string{"时间", "harness", "文件"}, rows), "  "))
		if target == "" {
			ui.Note("恢复某个：crapi restore <harness>")
		}
		return nil
	}
	b := backups[0]
	if term.Interactive() {
		ok, err := ui.Confirm(fmt.Sprintf("把 %s 恢复到 %s 的备份？", target, b.Stamp), "当前文件会被覆盖", true)
		if err != nil || !ok {
			return err
		}
	}
	restored, err := harness.Restore(b)
	for _, r := range restored {
		ui.Success("已恢复 %s", r)
	}
	if err == nil {
		delete(a.Cfg.Managed, target)
		err = a.Cfg.Save()
	}
	return err
}

// ---------- doctor ----------

func cmdDoctor(a *App, _ []string) error {
	ui.Banner(a.Version, a.Cfg.Base())
	g := ui.G()
	ui.Section("环境")
	ui.KV("系统", runtime.GOOS+"/"+runtime.GOARCH)
	ui.KV("终端", terminalName())
	glyph := "Unicode"
	if !term.Unicode() {
		glyph = "ASCII（兼容旧版控制台；设 CRAPI_GLYPHS=unicode 可强制切换）"
	}
	ui.KV("界面字形", glyph)
	ui.KV("中文测试", "Crosery · 你好，世界 "+g.OK)
	exe, _ := os.Executable()
	ui.KV("程序位置", exe)
	ui.KV("配置文件", store.Path())
	if p := proxyEnv(); p != "" {
		ui.KV("代理", p)
	}

	ui.Section("连通性")
	k := a.Cfg.Key()
	if k == "" {
		ui.Warn("未设置 API Key，跳过接口检查（运行 crapi setup）")
		return nil
	}
	c := a.clientWith(k)
	check := func(name string, fn func(ctx context.Context) (string, error)) {
		start := time.Now()
		ctx, cancel := context.WithTimeout(a.ctx, 30*time.Second)
		defer cancel()
		detail, err := fn(ctx)
		cost := ui.Dim.Render(fmt.Sprintf(" %dms", time.Since(start).Milliseconds()))
		switch {
		case errors.Is(err, api.ErrUnsupported):
			ui.Warn("%s  %s%s", ui.Pad(name, 14), "服务端暂未开放", cost)
		case err != nil:
			ui.Fail("%s  %v", ui.Pad(name, 14), err)
		default:
			ui.Success("%s  %s%s", ui.Pad(name, 14), detail, cost)
		}
	}
	check("网关 /v1/models", func(ctx context.Context) (string, error) {
		m, err := c.ListModels(ctx)
		return fmt.Sprintf("%d 个模型", len(m)), err
	})
	check("用量接口", func(ctx context.Context) (string, error) {
		u, err := c.GetUsage(ctx, 1)
		if err != nil {
			return "", err
		}
		return "Key：" + u.Key.Name, nil
	})
	check("号池接口", func(ctx context.Context) (string, error) {
		p, err := c.GetPool(ctx)
		if err != nil {
			return "", err
		}
		return fmt.Sprintf("%d 个渠道", len(p.Providers)), nil
	})
	if !onPath() {
		ui.Section("PATH")
		ui.Warn("crapi 所在目录不在 PATH 中，新开终端可能找不到 crapi 命令：%s", filepath.Dir(exe))
	}
	return nil
}

func terminalName() string {
	for _, k := range []string{"TERM_PROGRAM", "WT_SESSION", "ConEmuANSI", "TERM"} {
		if v := os.Getenv(k); v != "" {
			if k == "WT_SESSION" {
				return "Windows Terminal"
			}
			return v
		}
	}
	if runtime.GOOS == "windows" {
		if os.Getenv("PSModulePath") != "" && os.Getenv("PROMPT") == "" {
			return "PowerShell（conhost）"
		}
		return "cmd（conhost）"
	}
	return "未知"
}

func proxyEnv() string {
	for _, k := range []string{"HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"} {
		if v := os.Getenv(k); v != "" {
			return k + "=" + v
		}
	}
	return ""
}

func onPath() bool {
	p, err := exec.LookPath("crapi")
	if err != nil {
		return false
	}
	exe, _ := os.Executable()
	a, _ := filepath.EvalSymlinks(p)
	b, _ := filepath.EvalSymlinks(exe)
	return strings.EqualFold(filepath.Dir(a), filepath.Dir(b)) || a != ""
}
