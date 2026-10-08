package ui

import (
	"strconv"
	"strings"

	"charm.land/lipgloss/v2"
)

// TreeNode 是树形输出里的一行：Cells 为各列，Children 挂在它下面。
// 同一深度、同一 Kind 的行共用列宽（Kind 用来区分同一层里列含义不同的行），Aligns 缺省左对齐。
type TreeNode struct {
	Cells    []string
	Aligns   []Align
	Kind     string
	Children []TreeNode
}

// Tree 把 nodes 渲染成挂在上一行（通常是 Section 标题）下面的树：├─ / └─ 连接，旧控制台用 |- / `-。
// 列宽按显示宽度计算（中英文混排对齐），行末不补空格；颜色由 Out 按终端能力降级，非 TTY 下是纯文本。
func Tree(nodes []TreeNode) string { return renderTree(nodes, G()) }

func renderTree(nodes []TreeNode, g Glyphs) string {
	widths := map[string][]int{}
	var measure func(list []TreeNode, depth int)
	measure = func(list []TreeNode, depth int) {
		for _, n := range list {
			key := treeKey(depth, n.Kind)
			w := widths[key]
			for i, c := range trimCells(n.Cells) {
				if i == len(w) {
					w = append(w, 0)
				}
				w[i] = max(w[i], lipgloss.Width(c))
			}
			widths[key] = w
			measure(n.Children, depth+1)
		}
	}
	measure(nodes, 0)

	var lines []string
	var walk func(list []TreeNode, depth int, prefix string)
	walk = func(list []TreeNode, depth int, prefix string) {
		for i, n := range list {
			branch, next := g.TreeTee, Dim.Render(g.TreePipe)
			if i == len(list)-1 {
				branch, next = g.TreeEnd, strings.Repeat(" ", lipgloss.Width(g.TreeEnd))
			}
			lines = append(lines, prefix+Dim.Render(branch)+treeRow(n, widths[treeKey(depth, n.Kind)]))
			walk(n.Children, depth+1, prefix+next)
		}
	}
	walk(nodes, 0, "")
	return strings.Join(lines, "\n")
}

func treeKey(depth int, kind string) string { return strconv.Itoa(depth) + "/" + kind }

func treeRow(n TreeNode, widths []int) string {
	cells := trimCells(n.Cells)
	var b strings.Builder
	for i, c := range cells {
		if widths[i] == 0 {
			continue // 这一列在同层所有行里都是空的
		}
		if b.Len() > 0 {
			b.WriteString("  ")
		}
		gap := strings.Repeat(" ", widths[i]-lipgloss.Width(c))
		switch {
		case i < len(n.Aligns) && n.Aligns[i] == Right:
			b.WriteString(gap + c)
		case i < len(cells)-1:
			b.WriteString(c + gap)
		default:
			b.WriteString(c)
		}
	}
	return b.String()
}

// trimCells 去掉行尾的空列，避免行末留空格。
func trimCells(cells []string) []string {
	for len(cells) > 0 && cells[len(cells)-1] == "" {
		cells = cells[:len(cells)-1]
	}
	return cells
}
