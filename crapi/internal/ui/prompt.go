package ui

import (
	"context"
	"errors"

	"charm.land/huh/v2"
	"charm.land/huh/v2/spinner"
	"charm.land/lipgloss/v2"

	"github.com/crosery/crapi/internal/term"
)

// ErrAborted 表示用户按 Esc / Ctrl+C 取消了表单。
var ErrAborted = errors.New("已取消")

// Option 是选择题的一个选项。
type Option struct {
	Label    string
	Value    string
	Selected bool
}

func theme() huh.Theme {
	return huh.ThemeFunc(func(isDark bool) *huh.Styles {
		t := huh.ThemeCharm(isDark)
		t.Focused.Title = t.Focused.Title.Foreground(Brand)
		t.Focused.NoteTitle = t.Focused.NoteTitle.Foreground(Brand)
		t.Focused.SelectSelector = t.Focused.SelectSelector.Foreground(Brand)
		t.Focused.MultiSelectSelector = t.Focused.MultiSelectSelector.Foreground(Brand)
		t.Focused.TextInput.Prompt = t.Focused.TextInput.Prompt.Foreground(Brand)
		t.Focused.FocusedButton = t.Focused.FocusedButton.Background(Brand).Foreground(lipgloss.Color("#1F1300"))
		t.Focused.Next = t.Focused.FocusedButton
		t.Focused.SelectedPrefix = t.Focused.SelectedPrefix.Foreground(OKC)
		if !term.Unicode() {
			// 旧版 conhost：粗竖线与对勾在中文字体下是双宽，换成 ASCII。
			t.Focused.Base = t.Focused.Base.BorderStyle(lipgloss.NormalBorder())
			t.Focused.Card = t.Focused.Base
			t.Focused.SelectedPrefix = t.Focused.SelectedPrefix.SetString("[x] ")
			t.Focused.UnselectedPrefix = t.Focused.UnselectedPrefix.SetString("[ ] ")
			t.Focused.NextIndicator = t.Focused.NextIndicator.SetString("->")
			t.Focused.PrevIndicator = t.Focused.PrevIndicator.SetString("<-")
			t.Blurred = t.Focused
			t.Blurred.Base = t.Focused.Base.BorderStyle(lipgloss.HiddenBorder())
			t.Blurred.Card = t.Blurred.Base
			t.Blurred.MultiSelectSelector = lipgloss.NewStyle().SetString("  ")
		} else {
			t.Blurred.Title = t.Focused.Title
		}
		return t
	})
}

func run(f *huh.Form) error {
	err := f.WithTheme(theme()).Run()
	if errors.Is(err, huh.ErrUserAborted) {
		return ErrAborted
	}
	return err
}

// AskSecret 以掩码方式读取一段秘密（API Key）。
func AskSecret(title, desc string, validate func(string) error) (string, error) {
	var v string
	in := huh.NewInput().Title(title).Description(desc).
		EchoMode(huh.EchoModePassword).
		Placeholder("sk-...").
		Value(&v)
	if validate != nil {
		in = in.Validate(validate)
	}
	return v, run(huh.NewForm(huh.NewGroup(in)))
}

// AskText 读取一行普通文本。
func AskText(title, desc, placeholder string, validate func(string) error) (string, error) {
	var v string
	in := huh.NewInput().Title(title).Description(desc).Placeholder(placeholder).Value(&v)
	if validate != nil {
		in = in.Validate(validate)
	}
	return v, run(huh.NewForm(huh.NewGroup(in)))
}

// AskMulti 多选；返回选中项的 Value。
func AskMulti(title, desc string, options []Option) ([]string, error) {
	var picked []string
	opts := make([]huh.Option[string], 0, len(options))
	for _, o := range options {
		opts = append(opts, huh.NewOption(o.Label, o.Value).Selected(o.Selected))
	}
	height := len(opts) + 2
	if height > 16 {
		height = 16
	}
	f := huh.NewForm(huh.NewGroup(
		huh.NewMultiSelect[string]().Title(title).Description(desc).
			Options(opts...).Height(height).Value(&picked),
	))
	return picked, run(f)
}

// AskSelect 单选；返回选中项的 Value。
func AskSelect(title, desc string, options []Option) (string, error) {
	var picked string
	opts := make([]huh.Option[string], 0, len(options))
	for _, o := range options {
		opts = append(opts, huh.NewOption(o.Label, o.Value).Selected(o.Selected))
	}
	height := len(opts) + 2
	if height > 14 {
		height = 14
	}
	f := huh.NewForm(huh.NewGroup(
		huh.NewSelect[string]().Title(title).Description(desc).Options(opts...).Height(height).Value(&picked),
	))
	return picked, run(f)
}

// Confirm 是/否确认。
func Confirm(title, desc string, def bool) (bool, error) {
	v := def
	f := huh.NewForm(huh.NewGroup(
		huh.NewConfirm().Title(title).Description(desc).Affirmative("是").Negative("否").Value(&v),
	))
	return v, run(f)
}

// Spin 在交互终端里显示转圈动画执行 fn；非交互环境直接执行。
func Spin(title string, fn func(ctx context.Context) error) error {
	if !term.Interactive() {
		return fn(context.Background())
	}
	var ferr error
	s := spinner.New().Title(" " + title).
		ActionWithErr(func(ctx context.Context) error {
			ferr = fn(ctx)
			return nil
		})
	if !term.Unicode() {
		s = s.Type(spinner.Line)
	} else {
		s = s.Type(spinner.Dots)
	}
	if err := s.Run(); err != nil && ferr == nil {
		return err
	}
	return ferr
}
