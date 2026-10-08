// Package ui 集中放置 crapi 的视觉语言：配色、字形、分节标题、表格、进度条与格式化。
// 所有输出都经过 colorprofile writer，自动按终端能力降级颜色（含 NO_COLOR）。
package ui

import (
	"fmt"
	"image/color"
	"io"
	"math"
	"os"
	"strings"

	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/colorprofile"

	"github.com/crosery/crapi/internal/term"
)

// 中间调配色：深色与浅色背景下都可读，不依赖终端背景探测
// （探测在部分 Windows 控制台里会卡住或回显转义序列）。
var (
	Brand  color.Color = lipgloss.Color("#F5A524") // Crosery 品牌黄
	Accent color.Color = lipgloss.Color("#14B8A6")
	Muted  color.Color = lipgloss.Color("#8A8F98")
	OKC    color.Color = lipgloss.Color("#22C55E")
	WarnC  color.Color = lipgloss.Color("#EAB308")
	ErrC   color.Color = lipgloss.Color("#EF4444")
	InfoC  color.Color = lipgloss.Color("#60A5FA")
)

var (
	Out io.Writer = colorprofile.NewWriter(os.Stdout, os.Environ())
	Err io.Writer = colorprofile.NewWriter(os.Stderr, os.Environ())
)

// Glyphs 是一套可整体替换的字形；旧版 conhost 使用 ASCII 版本。
type Glyphs struct {
	OK, Fail, Warn, Info, Arrow, Dot, Bullet, Mark, Sep string
	BarFull, BarEmpty                                   string
	BarParts                                            []string // 由细到粗的部分块，ASCII 模式为空
	Border                                              lipgloss.Border
	Rule                                                string
	TreeTee, TreeEnd, TreePipe                          string // 树形输出的分支、末枝与竖线，都是 3 列宽
}

var unicodeGlyphs = Glyphs{
	OK: "✓", Fail: "✗", Warn: "!", Info: "i", Arrow: "→", Dot: "●", Bullet: "•", Mark: "◆", Sep: "│",
	BarFull: "█", BarEmpty: "░",
	BarParts: []string{"▏", "▎", "▍", "▌", "▋", "▊", "▉"},
	Border:   lipgloss.RoundedBorder(),
	Rule:     "─",
	TreeTee:  "├─ ", TreeEnd: "└─ ", TreePipe: "│  ",
}

var asciiGlyphs = Glyphs{
	OK: "+", Fail: "x", Warn: "!", Info: "i", Arrow: "->", Dot: "*", Bullet: "-", Mark: "*", Sep: "|",
	BarFull: "#", BarEmpty: ".",
	Border:  lipgloss.ASCIIBorder(),
	Rule:    "-",
	TreeTee: "|- ", TreeEnd: "`- ", TreePipe: "|  ",
}

// G 返回当前终端使用的字形。
func G() Glyphs {
	if term.Unicode() {
		return unicodeGlyphs
	}
	return asciiGlyphs
}

func fg(c color.Color) lipgloss.Style { return lipgloss.NewStyle().Foreground(c) }

var (
	Bold    = lipgloss.NewStyle().Bold(true)
	Dim     = fg(Muted)
	BrandS  = fg(Brand).Bold(true)
	AccentS = fg(Accent)
	OKS     = fg(OKC)
	WarnS   = fg(WarnC)
	ErrS    = fg(ErrC)
	InfoS   = fg(InfoC)
)

// Println 以自动降级的颜色写到标准输出。
func Println(a ...any) { _, _ = fmt.Fprintln(Out, a...) }

// Printf 同上，带格式化。
func Printf(format string, a ...any) { _, _ = fmt.Fprintf(Out, format, a...) }

// ClearScreen 清除当前终端屏幕并把光标重置到左上角，保持控制台单屏显示。
func ClearScreen() {
	if term.Interactive() {
		fmt.Print("\033[2J\033[H")
	}
}

// Banner 打印品牌头。
func Banner(version, baseURL string) {
	g := G()
	title := BrandS.Render(g.Mark+" crapi") + "  " + Bold.Render("Crosery CPA 一键接入") + "  " + Dim.Render(version)
	sub := Dim.Render(baseURL)
	box := lipgloss.NewStyle().
		Border(g.Border).
		BorderForeground(Brand).
		Padding(0, 2).
		Render(title + "\n" + sub)
	Println(box)
}

// Section 打印分节标题。
func Section(title string, hint ...string) {
	line := BrandS.Render(G().Mark) + " " + Bold.Render(title)
	if len(hint) > 0 && hint[0] != "" {
		line += "  " + Dim.Render(hint[0])
	}
	Println()
	Println(line)
}

// Success / Warn / Fail / Note 为统一的状态行。
func Success(format string, a ...any) {
	Println(OKS.Render(G().OK) + " " + fmt.Sprintf(format, a...))
}

func Warn(format string, a ...any) {
	Println(WarnS.Render(G().Warn) + " " + fmt.Sprintf(format, a...))
}

func Fail(format string, a ...any) {
	_, _ = fmt.Fprintln(Err, ErrS.Render(G().Fail)+" "+fmt.Sprintf(format, a...))
}

func Note(format string, a ...any) {
	Println(Dim.Render("  " + fmt.Sprintf(format, a...)))
}

// KV 打印一行对齐的「标签 值」。
func KV(label string, value string) {
	pad := 10 - lipgloss.Width(label)
	if pad < 1 {
		pad = 1
	}
	Println("  " + Dim.Render(label) + strings.Repeat(" ", pad) + value)
}

// Bar 渲染一条比例条，ratio 取 [0,1]；颜色按水位自动选择，也可显式传入。
func Bar(ratio float64, width int, c ...color.Color) string {
	if math.IsNaN(ratio) || ratio < 0 {
		ratio = 0
	}
	if ratio > 1 {
		ratio = 1
	}
	g := G()
	col := LevelColor(ratio)
	if len(c) > 0 && c[0] != nil {
		col = c[0]
	}
	cells := ratio * float64(width)
	full := int(cells)
	var b strings.Builder
	b.WriteString(strings.Repeat(g.BarFull, full))
	used := full
	if len(g.BarParts) > 0 && full < width {
		frac := cells - float64(full)
		idx := int(frac * float64(len(g.BarParts)+1))
		if idx > 0 {
			b.WriteString(g.BarParts[idx-1])
			used++
		}
	}
	filled := fg(col).Render(b.String())
	return filled + Dim.Render(strings.Repeat(g.BarEmpty, width-used))
}

// LevelColor：<60% 绿，<85% 黄，其余红。
func LevelColor(ratio float64) color.Color {
	switch {
	case ratio < 0.6:
		return OKC
	case ratio < 0.85:
		return WarnC
	default:
		return ErrC
	}
}

// Tokens 把 token 数格式化为 1.2K / 3.4M / 5.6B。
func Tokens(n float64) string {
	switch {
	case n >= 1e9:
		return trimZero(fmt.Sprintf("%.2f", n/1e9)) + "B"
	case n >= 1e6:
		return trimZero(fmt.Sprintf("%.2f", n/1e6)) + "M"
	case n >= 1e3:
		return trimZero(fmt.Sprintf("%.1f", n/1e3)) + "K"
	default:
		return fmt.Sprintf("%.0f", n)
	}
}

// USD 格式化美元金额。
func USD(v float64) string {
	switch {
	case v >= 1000:
		return "$" + commas(fmt.Sprintf("%.0f", v))
	case v >= 1:
		return fmt.Sprintf("$%.2f", v)
	case v > 0:
		return fmt.Sprintf("$%.4f", v)
	default:
		return "$0"
	}
}

// Count 用千分位格式化整数。
func Count(n float64) string { return commas(fmt.Sprintf("%.0f", n)) }

func trimZero(s string) string {
	if strings.Contains(s, ".") {
		s = strings.TrimRight(strings.TrimRight(s, "0"), ".")
	}
	return s
}

func commas(s string) string {
	neg := strings.HasPrefix(s, "-")
	s = strings.TrimPrefix(s, "-")
	var b strings.Builder
	for i, r := range s {
		if i > 0 && (len(s)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(r)
	}
	if neg {
		return "-" + b.String()
	}
	return b.String()
}

// Ctx 把上下文长度格式化为 200K / 1M。
func Ctx(n int) string {
	switch {
	case n <= 0:
		return "-"
	case n >= 1_000_000 && n%1_000_000 == 0:
		return fmt.Sprintf("%dM", n/1_000_000)
	case n >= 1_000_000:
		return trimZero(fmt.Sprintf("%.2f", float64(n)/1e6)) + "M"
	default:
		return fmt.Sprintf("%dK", int(math.Round(float64(n)/1000)))
	}
}

// Pad 按显示宽度右侧补空格（中英文混排安全）。
func Pad(s string, width int) string {
	if w := lipgloss.Width(s); w < width {
		return s + strings.Repeat(" ", width-w)
	}
	return s
}

// Truncate 按显示宽度截断字符串（中英文混排安全）。
func Truncate(s string, width int) string {
	if lipgloss.Width(s) <= width {
		return s
	}
	var b strings.Builder
	w := 0
	for _, r := range s {
		rw := lipgloss.Width(string(r))
		if w+rw > width-1 {
			break
		}
		b.WriteRune(r)
		w += rw
	}
	if term.Unicode() {
		return b.String() + "…"
	}
	return b.String() + "~"
}
