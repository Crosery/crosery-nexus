package ui

import (
	"regexp"
	"strings"
	"testing"
)

var ansiRE = regexp.MustCompile(`\x1b\[[0-9;:]*m`)

func plain(s string) string { return ansiRE.ReplaceAllString(s, "") }

func TestRenderTree(t *testing.T) {
	cases := []struct {
		name  string
		g     Glyphs
		nodes []TreeNode
		want  string
	}{
		{
			name: "两层，同深度的列按显示宽度对齐（中英文混排）",
			g:    unicodeGlyphs,
			nodes: []TreeNode{
				{Cells: []string{"Anthropic", "2 个"}, Children: []TreeNode{
					{Cells: []string{"claude-opus-5-5", "1M"}, Aligns: []Align{Left, Right}},
					{Cells: []string{"claude-haiku-4-5", "200K"}, Aligns: []Align{Left, Right}},
				}},
				{Cells: []string{"智谱 GLM", "1 个"}, Children: []TreeNode{
					{Cells: []string{"glm-5", "128K"}, Aligns: []Align{Left, Right}},
				}},
			},
			want: "" +
				"├─ Anthropic  2 个\n" +
				"│  ├─ claude-opus-5-5     1M\n" +
				"│  └─ claude-haiku-4-5  200K\n" +
				"└─ 智谱 GLM   1 个\n" +
				"   └─ glm-5             128K",
		},
		{
			name: "ASCII 字形",
			g:    asciiGlyphs,
			nodes: []TreeNode{
				{Cells: []string{"a"}, Children: []TreeNode{{Cells: []string{"b"}}, {Cells: []string{"c"}}}},
				{Cells: []string{"d"}},
			},
			want: "|- a\n|  |- b\n|  `- c\n`- d",
		},
		{
			name: "行尾空列不留空格；中间空列照常占位",
			g:    unicodeGlyphs,
			nodes: []TreeNode{
				{Cells: []string{"x", "", "tail"}},
				{Cells: []string{"long-name", "mid", ""}},
			},
			want: "├─ x               tail\n└─ long-name  mid",
		},
		{
			name: "同层全空的列整列省掉，不多留间隔",
			g:    unicodeGlyphs,
			nodes: []TreeNode{
				{Cells: []string{"Codex", "", "● 正常"}},
				{Cells: []string{"Antigravity", "", "● 紧张"}},
			},
			want: "├─ Codex        ● 正常\n└─ Antigravity  ● 紧张",
		},
		{
			name: "同深度不同 Kind 各自对齐",
			g:    unicodeGlyphs,
			nodes: []TreeNode{
				{Cells: []string{"全部", "x"}, Kind: "total"},
				{Cells: []string{"Codex", "y"}},
				{Cells: []string{"Antigravity", "z"}},
			},
			want: "├─ 全部  x\n├─ Codex        y\n└─ Antigravity  z",
		},
		{name: "空树", g: unicodeGlyphs, nodes: nil, want: ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := plain(renderTree(tc.nodes, tc.g))
			if got != tc.want {
				t.Fatalf("got:\n%s\nwant:\n%s", got, tc.want)
			}
			for _, line := range strings.Split(got, "\n") {
				if strings.HasSuffix(line, " ") {
					t.Fatalf("行尾有空格：%q", line)
				}
			}
		})
	}
}
