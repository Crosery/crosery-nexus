//go:build windows

package term

import (
	"os"
	"strings"

	"golang.org/x/sys/windows"
)

// platformSetup 把控制台代码页切到 UTF-8（65001），并为 stdout/stderr
// 打开 VT 转义处理，退出时全部恢复——代码页改动会残留在 cmd 窗口里，
// 不恢复的话用户之后跑的 GBK 程序会乱码。
func platformSetup() func() {
	var restores []func()

	if cp, err := windows.GetConsoleOutputCP(); err == nil && cp != 65001 {
		if windows.SetConsoleOutputCP(65001) == nil {
			restores = append(restores, func() { _ = windows.SetConsoleOutputCP(cp) })
		}
	}
	if cp, err := windows.GetConsoleCP(); err == nil && cp != 65001 {
		if windows.SetConsoleCP(65001) == nil {
			restores = append(restores, func() { _ = windows.SetConsoleCP(cp) })
		}
	}
	for _, f := range []*os.File{os.Stdout, os.Stderr} {
		h := windows.Handle(f.Fd())
		var mode uint32
		if windows.GetConsoleMode(h, &mode) != nil {
			continue
		}
		if mode&windows.ENABLE_VIRTUAL_TERMINAL_PROCESSING == 0 {
			if windows.SetConsoleMode(h, mode|windows.ENABLE_VIRTUAL_TERMINAL_PROCESSING) == nil {
				old := mode
				restores = append(restores, func() { _ = windows.SetConsoleMode(h, old) })
			}
		}
	}
	return func() {
		for i := len(restores) - 1; i >= 0; i-- {
			restores[i]()
		}
	}
}

// platformUnicode：Windows Terminal、VS Code、ConEmu、mintty(Git Bash) 等现代终端
// 按单宽渲染制表符；其余视为旧版 conhost，用 ASCII 保证对齐。
func platformUnicode() bool {
	if os.Getenv("WT_SESSION") != "" || os.Getenv("TERM_PROGRAM") != "" ||
		os.Getenv("ConEmuANSI") == "ON" || os.Getenv("WEZTERM_EXECUTABLE") != "" ||
		os.Getenv("ALACRITTY_WINDOW_ID") != "" {
		return true
	}
	return strings.Contains(os.Getenv("TERM"), "xterm")
}
