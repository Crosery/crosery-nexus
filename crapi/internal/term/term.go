// Package term 负责终端环境的准备：Windows 控制台代码页与 VT 转义、
// 以及「当前终端能否正确显示 Unicode 制表符」的判定。
package term

import (
	"os"
	"strings"

	xterm "github.com/charmbracelet/x/term"
)

var unicodeOK = true

// Setup 在程序启动时调用一次，返回的函数在退出前调用以恢复控制台原状。
func Setup() (restore func()) {
	restore = platformSetup()
	unicodeOK = decideUnicode()
	return restore
}

// Unicode 报告是否使用 Unicode 图形字符（圆角框、进度条块等）。
// 旧版 conhost 配合中文字体会把这些「宽度不明确」的字符画成双宽，
// 表格因此错位，这类终端退回 ASCII。
func Unicode() bool { return unicodeOK }

func decideUnicode() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("CRAPI_GLYPHS"))) {
	case "ascii":
		return false
	case "unicode", "utf8", "utf-8":
		return true
	}
	return platformUnicode()
}

// IsTTY 报告文件是否连接到交互式终端。
func IsTTY(f *os.File) bool { return xterm.IsTerminal(f.Fd()) }

// Interactive 报告是否可以弹出交互式表单。
func Interactive() bool {
	if os.Getenv("CI") != "" || os.Getenv("CRAPI_NONINTERACTIVE") != "" {
		return false
	}
	return IsTTY(os.Stdin) && IsTTY(os.Stdout)
}

// Width 返回终端宽度，拿不到时给一个保守值。
func Width() int {
	w, _, err := xterm.GetSize(os.Stdout.Fd())
	if err != nil || w <= 0 {
		return 100
	}
	return w
}
