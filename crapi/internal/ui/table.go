package ui

import (
	"charm.land/lipgloss/v2"
	"charm.land/lipgloss/v2/table"
)

// Align 指定列对齐方式。
type Align int

const (
	Left Align = iota
	Right
	Center
)

// Table 渲染带表头的表格；aligns 按列给出对齐，缺省左对齐。
func Table(headers []string, rows [][]string, aligns ...Align) string {
	g := G()
	header := lipgloss.NewStyle().Foreground(Brand).Bold(true).Padding(0, 1)
	cell := lipgloss.NewStyle().Padding(0, 1)
	t := table.New().
		Border(g.Border).
		BorderStyle(lipgloss.NewStyle().Foreground(Muted)).
		BorderRow(false).
		Headers(headers...).
		Rows(rows...).
		StyleFunc(func(row, col int) lipgloss.Style {
			s := cell
			if row == table.HeaderRow {
				s = header
			}
			if col < len(aligns) {
				switch aligns[col] {
				case Right:
					s = s.Align(lipgloss.Right)
				case Center:
					s = s.Align(lipgloss.Center)
				}
			}
			return s
		})
	return t.Render()
}

// Card 用品牌色边框包一段内容。
func Card(content string) string {
	return lipgloss.NewStyle().
		Border(G().Border).
		BorderForeground(Muted).
		Padding(0, 1).
		Render(content)
}
