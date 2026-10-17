// Package cli 实现 crapi 的命令行入口与各子命令。
package cli

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/crosery/crapi/internal/api"
	"github.com/crosery/crapi/internal/harness"
	"github.com/crosery/crapi/internal/store"
	"github.com/crosery/crapi/internal/term"
	"github.com/crosery/crapi/internal/ui"
)

// App 是一次运行的上下文。
type App struct {
	Version string
	Cfg     *store.Config
	ctx     context.Context
}

type command struct {
	name    string
	aliases []string
	summary string
	run     func(a *App, args []string) error
}

func commands() []command {
	return []command{
		{"setup", []string{"init", "config"}, "输入 API Key，一键配置本机所有 agent harness", cmdSetup},
		{"use", []string{"switch", "set-model"}, "快速切换已接入 harness 的默认主流模型", cmdUse},
		{"reload", []string{"reinit", "refresh"}, "智能重新初始化：自动为新安装的 agent CLI 完成接入并刷新", cmdReload},
		{"update", []string{"sync", "up"}, "从网关同步最新模型与渠道，刷新所有已接入的 harness", cmdUpdate},
		{"models", []string{"model", "ls"}, "查看当前 Key 可用的模型（按渠道分组）", cmdModels},
		{"channels", []string{"channel"}, "查看当前 Key 可用的渠道", cmdChannels},
		{"usage", []string{"quota", "u"}, "查看账号用量、额度与花费", cmdUsage},
		{"pool", []string{"pools", "p"}, "查看号池状态（账号数、冷却、额度窗口）", cmdPool},
		{"image", []string{"img", "draw"}, "生图：支持网关上全部生图模型，可带参考图", cmdImage},
		{"status", []string{"st", "list"}, "查看本机各 harness 的安装与接入状态", cmdStatus},
		{"reset", []string{"unsetup", "rollback", "restore"}, "一键退出 Crosery 配置，将工具退回原本的个人账号/官方状态", cmdReset},
		{"key", []string{"login"}, "设置 / 查看 / 清除 API Key", cmdKey},
		{"doctor", []string{"check"}, "诊断网络、Key、终端编码与配置路径", cmdDoctor},
		{"upgrade", []string{"self-update"}, "升级 crapi 自身到最新版本", cmdUpgrade},
		{"version", []string{"-v", "--version"}, "显示版本", cmdVersion},
		{"help", []string{"-h", "--help"}, "显示帮助", cmdHelp},
	}
}

// Main 是程序入口，返回退出码。
func Main(version string, args []string) int {
	var once sync.Once
	setup := term.Setup()
	restore := func() { once.Do(setup) }
	defer restore()

	// Ctrl+C：取消进行中的请求、恢复控制台代码页，稍后强制退出。
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt)
	go func() {
		<-sig
		cancel()
		restore()
		time.Sleep(1500 * time.Millisecond)
		os.Exit(130)
	}()

	cfg, err := store.Load()
	if err != nil {
		ui.Fail("读取配置失败（%s）：%v", store.Path(), err)
		return 1
	}
	a := &App{Version: version, Cfg: cfg, ctx: ctx}
	cleanupOld()
	_ = harness.SyncAllSkills(harness.DefaultEnv())
	checkAutoUpdate(a)

	if len(args) == 0 {
		err = cmdHome(a)
	} else {
		name := strings.ToLower(args[0])
		var found *command
		for _, c := range commands() {
			if c.name == name || contains(c.aliases, name) {
				c := c
				found = &c
				break
			}
		}
		if found == nil {
			ui.Fail("未知命令：%s", args[0])
			cmdHelp(a, nil)
			return 2
		}
		err = found.run(a, args[1:])
	}
	switch {
	case err == nil:
		return 0
	case errors.Is(err, ui.ErrAborted), errors.Is(err, context.Canceled):
		ui.Println(ui.Dim.Render("已取消"))
		return 130
	case errors.Is(err, flag.ErrHelp):
		return 0
	default:
		ui.Fail("%v", err)
		return 1
	}
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// client 返回带 Key 的 API 客户端；没有 Key 时报错提示。
func (a *App) client() (*api.Client, error) {
	key := a.Cfg.Key()
	if key == "" {
		return nil, errors.New("还没有设置 API Key，请先运行：crapi setup")
	}
	return a.clientWith(key), nil
}

func (a *App) clientWith(key string) *api.Client {
	ua := fmt.Sprintf("crapi/%s (%s; %s)", a.Version, runtime.GOOS, runtime.GOARCH)
	return api.New(a.Cfg.Base(), a.Cfg.Console(), key, ua)
}

// fetchModels 带转圈动画拉取模型列表。
func (a *App) fetchModels(c *api.Client) ([]api.Model, error) {
	var models []api.Model
	err := ui.Spin("正在读取可用模型…", func(ctx context.Context) error {
		var err error
		models, err = c.ListModels(a.ctx)
		return err
	})
	return models, err
}

// newFlags 创建子命令的参数集，错误输出写到 stderr 并附中文用法。
func newFlags(name, usage string) *flag.FlagSet {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	fs.Usage = func() {}
	_ = usage
	return fs
}

// parse 允许 flag 与位置参数交错（crapi image "一只猫" -m gpt-image-2.5-flare）。
func parse(fs *flag.FlagSet, args []string, help string) ([]string, error) {
	var flags, pos []string
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			pos = append(pos, args[i+1:]...)
			break
		}
		if arg == "-h" || arg == "--help" {
			ui.Println(help)
			return nil, flag.ErrHelp
		}
		if strings.HasPrefix(arg, "-") && len(arg) > 1 {
			flags = append(flags, arg)
			name := strings.TrimLeft(arg, "-")
			if strings.Contains(name, "=") {
				continue
			}
			if f := fs.Lookup(name); f != nil {
				if bf, ok := f.Value.(interface{ IsBoolFlag() bool }); ok && bf.IsBoolFlag() {
					continue
				}
				if i+1 < len(args) {
					flags = append(flags, args[i+1])
					i++
				}
			}
			continue
		}
		pos = append(pos, arg)
	}
	if err := fs.Parse(flags); err != nil {
		return nil, fmt.Errorf("%v\n\n%s", err, help)
	}
	return pos, nil
}

// multiFlag 支持重复出现的参数（-i a.png -i b.png）。
type multiFlag []string

func (m *multiFlag) String() string     { return strings.Join(*m, ",") }
func (m *multiFlag) Set(v string) error { *m = append(*m, v); return nil }

func cmdVersion(a *App, _ []string) error {
	ui.Printf("crapi %s (%s/%s)\n", a.Version, runtime.GOOS, runtime.GOARCH)
	return nil
}

func cmdHelp(a *App, _ []string) error {
	ui.Banner(a.Version, a.Cfg.Base())
	ui.Println()
	ui.Println(ui.Bold.Render("用法") + "  crapi <命令> [参数]      直接运行 crapi 进入交互菜单")
	ui.Println()
	for _, c := range commands() {
		if c.name == "help" || c.name == "version" {
			continue
		}
		ui.Printf("  %s  %s\n", ui.BrandS.Render(fmt.Sprintf("%-9s", c.name)), c.summary)
	}
	ui.Println()
	ui.Println(ui.Bold.Render("常用示例"))
	examples := [][2]string{
		{"crapi setup", "交互式：输入 Key，勾选要配置的 harness"},
		{"crapi setup --key sk-xxx --yes", "无交互：配置本机检测到的全部 harness"},
		{"crapi setup claude codex", "只配置指定的 harness"},
		{"crapi update", "同步网关最新模型到所有已接入的 harness"},
		{"crapi usage --days 7", "最近 7 天用量与额度"},
		{"crapi models --channel anthropic", "只看某个渠道的模型"},
		{`crapi image "一只戴墨镜的柯基" -n 2`, "生图，结果保存到当前目录"},
	}
	for _, e := range examples {
		ui.Printf("  %s  %s\n", ui.AccentS.Render(ui.Pad(e[0], 36)), ui.Dim.Render(e[1]))
	}
	ui.Println()
	ui.Println(ui.Dim.Render("每个命令都支持 -h 查看详细参数。环境变量：CRAPI_KEY（临时指定 Key）、CRAPI_GLYPHS=ascii（强制纯 ASCII 界面）。"))
	return nil
}
