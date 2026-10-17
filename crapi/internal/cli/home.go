package cli

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/crosery/crapi/internal/store"
	"github.com/crosery/crapi/internal/term"
	"github.com/crosery/crapi/internal/ui"
)

// cmdHome：不带参数运行 crapi。没有 Key 时直接进入 setup；有 Key 时显示交互菜单。
func cmdHome(a *App) error {
	if a.Cfg.Key() == "" {
		if !term.Interactive() {
			return cmdHelp(a, nil)
		}
		return cmdSetup(a, nil)
	}
	if !term.Interactive() {
		return cmdHelp(a, nil)
	}

	for {
		ui.ClearScreen()
		ui.Banner(a.Version, a.Cfg.Base())
		ui.KV("API Key", store.MaskKey(a.Cfg.Key()))
		if len(a.Cfg.Managed) > 0 {
			var names []string
			for id := range a.Cfg.Managed {
				names = append(names, id)
			}
			ui.KV("已接入", fmt.Sprintf("%d 个工具 (%s)", len(names), strings.Join(sortStrings(names), ", ")))
		}
		if a.Cfg.DefaultModel != "" {
			ui.KV("全局默认模型", a.Cfg.DefaultModel)
		}
		if !a.Cfg.LastUpdate.IsZero() {
			ui.KV("上次同步", a.Cfg.LastUpdate.Local().Format("2006-01-02 15:04"))
		}

		ui.Println()
		choice, err := ui.AskSelect("请选择功能：", "use", []ui.Option{
			{Label: ui.Pad("切换默认模型 (use)", 22) + ui.Dim.Render("单屏动态查看并切换各 Agent 主流模型 (支持实时打字搜索)"), Value: "use"},
			{Label: ui.Pad("智能重新适配 (reload)", 22) + ui.Dim.Render("自动识别新安装的 Agent CLI 并一键接入"), Value: "reload"},
			{Label: ui.Pad("同步最新模型 (update)", 22) + ui.Dim.Render("从网关拉取最新模型目录并增量刷新"), Value: "update"},
			{Label: ui.Pad("批量配置工具 (setup)", 22) + ui.Dim.Render("一键批量配置本机全部 Agent Harness"), Value: "setup"},
			{Label: ui.Pad("额度与用量 (usage)", 22) + ui.Dim.Render("今日/本周/总额度、Token 消耗与近况流水"), Value: "usage"},
			{Label: ui.Pad("上游号池状态 (pool)", 22) + ui.Dim.Render("各渠道号池健康状态、冷却与并发水位"), Value: "pool"},
			{Label: ui.Pad("快捷全量生图 (image)", 22) + ui.Dim.Render("gpt-image-2.5 批量生图与图像编辑"), Value: "image"},
			{Label: ui.Pad("工具接入状态 (status)", 22) + ui.Dim.Render("查看本机所有 Harness 安装与模型配置"), Value: "status"},
			{Label: ui.Pad("退回原本配置 (reset)", 22) + ui.Dim.Render("一键退出 Crosery 并恢复个人原本的账号与配置"), Value: "reset"},
			{Label: ui.Pad("更换 API Key (key)", 22) + ui.Dim.Render("重新设置当前生效的 Crosery API Key"), Value: "key"},
			{Label: ui.Pad("系统环境诊断 (doctor)", 22) + ui.Dim.Render("网络、终端编码与配置合法性检查"), Value: "doctor"},
			{Label: ui.Pad("退出 (quit)", 22) + ui.Dim.Render("退出 crapi 控制台"), Value: "quit"},
		})
		if err != nil || choice == "quit" {
			ui.ClearScreen()
			return nil
		}

		var runErr error
		pauseAfter := false

		switch choice {
		case "use":
			runErr = cmdUse(a, nil)
		case "reload":
			runErr = cmdReload(a, nil)
			pauseAfter = true
		case "update":
			runErr = cmdUpdate(a, nil)
			pauseAfter = true
		case "setup":
			runErr = cmdSetup(a, nil)
			pauseAfter = true
		case "usage":
			runErr = cmdUsage(a, nil)
			pauseAfter = true
		case "pool":
			runErr = cmdPool(a, nil)
			pauseAfter = true
		case "image":
			runErr = cmdImage(a, nil)
			pauseAfter = true
		case "status":
			runErr = cmdStatus(a, nil)
			pauseAfter = true
		case "reset":
			runErr = cmdReset(a, nil)
			pauseAfter = true
		case "key":
			runErr = cmdKey(a, []string{"set"})
		case "doctor":
			runErr = cmdDoctor(a, nil)
			pauseAfter = true
		}

		if runErr != nil && !errors.Is(runErr, ui.ErrAborted) {
			ui.Fail("%v", runErr)
			pauseAfter = true
		}

		if pauseAfter {
			ui.Println()
			ui.Note("按回车键返回主菜单...")
			_, _ = bufio.NewReader(os.Stdin).ReadBytes('\n')
		}
	}
}

func sortStrings(s []string) []string {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j] < s[j-1]; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
	return s
}

// ---------- upgrade ----------

// DownloadBase 是发布产物的下载根地址；需要 VERSION、SHA256SUMS 与 crapi-<os>-<arch>[.exe]。
// 默认首选七牛云 CDN 极速源，可用环境变量 CRAPI_DOWNLOAD_BASE 覆盖。
var DownloadBase = "https://cdn.crosery.com/crapi"

func downloadBase() string {
	if v := strings.TrimSpace(os.Getenv("CRAPI_DOWNLOAD_BASE")); v != "" {
		return strings.TrimRight(v, "/")
	}
	return DownloadBase
}

func assetName() string {
	name := fmt.Sprintf("crapi-%s-%s", runtime.GOOS, runtime.GOARCH)
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	return name
}

func httpGet(url string, limit int64) ([]byte, error) {
	client := &http.Client{Timeout: 5 * time.Minute}
	resp, err := client.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("%s 返回 HTTP %d", url, resp.StatusCode)
	}
	return io.ReadAll(io.LimitReader(resp.Body, limit))
}

func cmdUpgrade(a *App, args []string) error {
	fs := newFlags("upgrade", "crapi upgrade [--force]")
	force := fs.Bool("force", false, "")
	if _, err := parse(fs, args, "crapi upgrade [--force]   升级到最新版本"); err != nil {
		return err
	}
	base := downloadBase()
	var raw []byte
	if err := ui.Spin("正在检查新版本…", func(context.Context) error {
		var err error
		raw, err = httpGet(base+"/VERSION", 1<<10)
		return err
	}); err != nil {
		return fmt.Errorf("检查新版本失败：%w", err)
	}
	latest := strings.TrimSpace(string(raw))
	if latest == a.Version && !*force {
		ui.Success("已经是最新版本 %s", latest)
		return nil
	}
	ui.KV("当前版本", a.Version)
	ui.KV("最新版本", latest)
	var bin []byte
	if err := ui.Spin("正在下载 "+assetName()+"…", func(context.Context) error {
		var err error
		bin, err = httpGet(base+"/"+assetName(), 200<<20)
		return err
	}); err != nil {
		return err
	}
	if sums, err := httpGet(base+"/SHA256SUMS", 64<<10); err == nil {
		sum := sha256.Sum256(bin)
		want := ""
		for _, line := range strings.Split(string(sums), "\n") {
			f := strings.Fields(line)
			if len(f) == 2 && strings.TrimPrefix(f[1], "*") == assetName() {
				want = f[0]
			}
		}
		if want != "" && !strings.EqualFold(want, hex.EncodeToString(sum[:])) {
			return errors.New("校验和不一致，已中止升级")
		}
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	exe, _ = filepath.EvalSymlinks(exe)
	tmp := exe + ".new"
	if err := os.WriteFile(tmp, bin, 0o755); err != nil {
		return fmt.Errorf("写入新版本失败（可能需要管理员权限）：%w", err)
	}
	if runtime.GOOS == "windows" {
		// 运行中的 exe 不能被覆盖，但可以改名；旧文件下次启动时清理。
		old := exe + ".old"
		_ = os.Remove(old)
		if err := os.Rename(exe, old); err != nil {
			return err
		}
	}
	if err := os.Rename(tmp, exe); err != nil {
		return err
	}
	ui.Success("已升级到 %s", latest)
	return nil
}

// cleanupOld 删除 Windows 升级留下的旧 exe。
func cleanupOld() {
	if runtime.GOOS != "windows" {
		return
	}
	if exe, err := os.Executable(); err == nil {
		_ = os.Remove(exe + ".old")
	}
}

// checkAutoUpdate 在每次运行任意命令时，轻量检测上游最新版本；发现更新时自动秒级热替换当前二进制。
func checkAutoUpdate(a *App) {
	if os.Getenv("CRAPI_NO_AUTO_UPDATE") == "1" {
		return
	}
	base := downloadBase()
	client := &http.Client{Timeout: 1500 * time.Millisecond}
	resp, err := client.Get(base + "/VERSION")
	if err != nil || resp.StatusCode != 200 {
		return
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 64))
	if err != nil {
		return
	}
	latest := strings.TrimSpace(string(raw))
	if latest == "" || latest == a.Version || a.Version == "dev" {
		return
	}

	// 发现上游存在新版本，快速拉取对应二进制
	ui.Note("检测到上游新版本 v%s（当前: v%s），正在自动更新...", latest, a.Version)
	bin, err := httpGet(base+"/"+assetName(), 100<<20)
	if err != nil {
		return
	}
	if sums, err := httpGet(base+"/SHA256SUMS", 64<<10); err == nil {
		sum := sha256.Sum256(bin)
		want := ""
		for _, line := range strings.Split(string(sums), "\n") {
			f := strings.Fields(line)
			if len(f) == 2 && strings.TrimPrefix(f[1], "*") == assetName() {
				want = f[0]
			}
		}
		if want != "" && !strings.EqualFold(want, hex.EncodeToString(sum[:])) {
			return
		}
	}

	exe, err := os.Executable()
	if err != nil {
		return
	}
	exe, _ = filepath.EvalSymlinks(exe)
	tmp := exe + ".new"
	if err := os.WriteFile(tmp, bin, 0o755); err != nil {
		return
	}
	if runtime.GOOS == "windows" {
		old := exe + ".old"
		_ = os.Remove(old)
		if err := os.Rename(exe, old); err != nil {
			_ = os.Remove(tmp)
			return
		}
	}
	if err := os.Rename(tmp, exe); err == nil {
		ui.Success("crapi 已自动热更新至最新版本 v%s！", latest)
		a.Version = latest
	}
}
