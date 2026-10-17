package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/crosery/crapi/internal/api"
	"github.com/crosery/crapi/internal/ui"
)

const usageHelp = `crapi usage [参数]

查看当前 API Key 的额度（日 / 周 / 总）、花费与按模型的用量排行。

参数：
  --days <N>      统计最近 N 天（默认 7）
  --requests      同时列出最近的请求明细
  --limit <N>     请求明细条数（默认 15）
  --json          输出 JSON`

func cmdUsage(a *App, args []string) error {
	fs := newFlags("usage", usageHelp)
	days := fs.Int("days", 7, "")
	withReq := fs.Bool("requests", false, "")
	limit := fs.Int("limit", 15, "")
	asJSON := fs.Bool("json", false, "")
	if _, err := parse(fs, args, usageHelp); err != nil {
		return err
	}
	c, err := a.client()
	if err != nil {
		return err
	}
	var u *api.Usage
	var reqs []api.RequestItem
	load := func(ctx context.Context) error {
		var err error
		u, err = c.GetUsage(a.ctx, *days)
		if err != nil {
			return err
		}
		if *withReq {
			reqs, err = c.GetRequests(a.ctx, *days, *limit)
		}
		return err
	}
	if *asJSON {
		if err := load(a.ctx); err != nil {
			return err
		}
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(map[string]any{"usage": u, "requests": reqs})
	}
	if err := ui.Spin("正在读取用量…", load); err != nil {
		return err
	}
	renderUsage(u)
	if *withReq {
		renderRequests(reqs)
	}
	return nil
}

func renderUsage(u *api.Usage) {
	name := u.Key.Name
	if name == "" {
		name = "当前 Key"
	}
	hint := fmt.Sprintf("最近 %d 天", u.Days)
	if u.TrackingSince != nil {
		hint += "  统计自 " + shortTime(*u.TrackingSince)
	}
	ui.Section("账号用量 · "+name, hint)
	ui.Println(ui.Tree(usageTree(u)))
	if len(u.Models) == 0 {
		ui.Println()
		ui.Note("这段时间还没有请求记录。")
		return
	}
	if len(u.Models) > 15 {
		ui.Note("另有 %d 个模型未显示，用 --json 查看全部", len(u.Models)-15)
	}
	if len(u.UnpricedModels) > 0 {
		ui.Note("未定价（不计入花费与额度）：%s", strings.Join(u.UnpricedModels, ", "))
	}
}

// usageTree：额度（日 / 周 / 累计）→ 合计 → 按模型，层级与命名同控制台 /me 概览与用量页
// （src/features/me/meModel.ts quotaRows、MeUsagePage.vue「按模型 · 花费」）。
func usageTree(u *api.Usage) []ui.TreeNode {
	g := ui.G()
	var nodes []ui.TreeNode
	if u.BlockedReason != nil && *u.BlockedReason != "" {
		nodes = append(nodes, ui.TreeNode{Cells: []string{ui.ErrS.Render(g.Fail + " 已被暂停：" + *u.BlockedReason)}, Kind: "blocked"})
	}

	if q := u.Quota; q != nil {
		head := ui.TreeNode{Cells: []string{ui.Bold.Render("额度")}, Kind: "head"}
		if q.Unlimited {
			head.Cells = append(head.Cells, ui.OKS.Render(g.Dot+" 不限额度")+ui.Dim.Render("  以下为已消费金额（按官方单价估算）"))
		}
		for _, w := range []struct {
			label string
			win   *api.QuotaWindow
		}{{"日", q.Daily}, {"周", q.Weekly}, {"累计", q.Total}} {
			if w.win != nil {
				head.Children = append(head.Children, quotaNode(w.label, w.win))
			}
		}
		nodes = append(nodes, head)
	}

	t := u.Totals
	cacheRatio := 0.0
	if in := t.NewInputTokens + t.CacheTokens; in > 0 {
		cacheRatio = t.CacheTokens / in
	}
	stats := []string{
		stat("请求", ui.Count(t.Requests)),
		stat("总 Token", ui.Tokens(t.TotalTokens)),
		stat("输入", ui.Tokens(t.NewInputTokens)),
		stat("输出", ui.Tokens(t.OutputTokens)),
		stat("缓存读", ui.Tokens(t.CacheTokens)+ui.Dim.Render(fmt.Sprintf(" %.0f%%", cacheRatio*100))),
		stat("估算花费", ui.BrandS.Render(ui.USD(t.TotalCostUsd))),
	}
	nodes = append(nodes, ui.TreeNode{Cells: []string{ui.Bold.Render("合计"), strings.Join(stats, ui.Dim.Render(" · "))}, Kind: "head"})

	models := append([]api.ModelUsage(nil), u.Models...)
	if len(models) == 0 {
		return nodes
	}
	sort.Slice(models, func(i, j int) bool {
		ci, cj := cost(models[i]), cost(models[j])
		if ci != cj {
			return ci > cj
		}
		return models[i].TotalTokens > models[j].TotalTokens
	})
	maxCost, priced := 0.0, false
	for _, m := range models {
		maxCost = max(maxCost, cost(m))
		priced = priced || m.TotalCostUsd != nil
	}
	title := "按模型 · Token"
	if priced {
		title = "按模型 · 花费"
	}
	head := ui.TreeNode{Cells: []string{ui.Bold.Render(title), ui.Dim.Render(fmt.Sprintf("共 %d 个模型", len(models)))}, Kind: "head"}
	for i, m := range models {
		if i >= 15 {
			break
		}
		share := ""
		if maxCost > 0 {
			share = ui.Bar(cost(m)/maxCost, 14, ui.Brand)
		}
		costStr := ui.Dim.Render("未定价")
		if m.TotalCostUsd != nil {
			costStr = ui.USD(*m.TotalCostUsd)
		}
		head.Children = append(head.Children, ui.TreeNode{
			Cells: []string{
				ui.Truncate(m.Model, 30),
				ui.Count(m.Requests) + " 次",
				"输入 " + ui.Tokens(m.NewInputTokens),
				"输出 " + ui.Tokens(m.OutputTokens),
				"缓存读 " + ui.Tokens(m.CacheTokens),
				costStr,
				share,
			},
			Aligns: []ui.Align{ui.Left, ui.Right, ui.Right, ui.Right, ui.Right, ui.Right},
			Kind:   "model",
		})
	}
	return append(nodes, head)
}

func stat(label, value string) string {
	return ui.Dim.Render(label) + " " + ui.Bold.Render(value)
}

func cost(m api.ModelUsage) float64 {
	if m.TotalCostUsd == nil {
		return 0
	}
	return *m.TotalCostUsd
}

// quotaNode 是额度窗口的一行：窗口名 · 进度条 · 比例 · 已用 / 上限 · 重置。
func quotaNode(label string, w *api.QuotaWindow) ui.TreeNode {
	reset := ""
	if w.ResetsAt != nil && *w.ResetsAt != "" {
		reset = ui.Dim.Render(" · " + untilReset(*w.ResetsAt) + "后重置")
	} else if label == "累计" {
		reset = ui.Dim.Render(" · 不自动重置")
	}
	aligns := []ui.Align{ui.Left, ui.Left, ui.Right}
	if w.LimitUsd <= 0 {
		return ui.TreeNode{Cells: []string{label, ui.Bar(0, 24), "", ui.Bold.Render(ui.USD(w.SpentUsd)) + ui.Dim.Render(" / 不限") + reset}, Aligns: aligns, Kind: "quota"}
	}
	ratio := w.SpentUsd / w.LimitUsd
	status := ""
	if w.Exceeded {
		status = " " + ui.ErrS.Render("已超额")
	}
	return ui.TreeNode{
		Cells:  []string{label, ui.Bar(ratio, 24), fmt.Sprintf("%.0f%%", ratio*100), ui.Bold.Render(ui.USD(w.SpentUsd)) + ui.Dim.Render(" / "+ui.USD(w.LimitUsd)) + status + reset},
		Aligns: aligns,
		Kind:   "quota",
	}
}

func untilReset(ts string) string {
	t, err := time.Parse(time.RFC3339Nano, ts)
	if err != nil {
		return ts
	}
	d := time.Until(t)
	if d <= 0 {
		return "即将"
	}
	h := int(d.Hours())
	m := int(d.Minutes()) % 60
	switch {
	case h >= 48:
		return fmt.Sprintf("%d 天 %d 小时", h/24, h%24)
	case h > 0:
		return fmt.Sprintf("%d 小时 %d 分", h, m)
	default:
		return fmt.Sprintf("%d 分钟", m)
	}
}

func shortTime(ts string) string {
	t, err := time.Parse(time.RFC3339Nano, ts)
	if err != nil {
		return ts
	}
	return t.Local().Format("2006-01-02 15:04")
}

// renderRequests 的列与控制台「最近请求」表一致（MeRequestTable.vue）：时间 · 模型 · 状态 · Token · 缓存读 · 首字 · 耗时。
func renderRequests(items []api.RequestItem) {
	ui.Println()
	ui.Println("  " + ui.Bold.Render("最近请求") + ui.Dim.Render(fmt.Sprintf("  %d 条", len(items))))
	if len(items) == 0 {
		ui.Note("没有请求记录")
		return
	}
	ui.Println(indent(requestsTable(items), "  "))
}

func requestsTable(items []api.RequestItem) string {
	g := ui.G()
	var rows [][]string
	for _, it := range items {
		st := ui.OKS.Render(g.OK + fmt.Sprintf(" %d", it.StatusCode))
		if it.Success == 0 {
			st = ui.ErrS.Render(g.Fail + fmt.Sprintf(" %d", it.StatusCode))
		}
		total := it.TotalTokens
		if total <= 0 {
			total = it.InputTokens + it.OutputTokens
		}
		cached := "—"
		if it.CachedTokens > 0 {
			cached = ui.Tokens(it.CachedTokens)
		}
		ttft := "—"
		if it.TTFTMs > 0 {
			ttft = duration(it.TTFTMs)
		}
		rows = append(rows, []string{
			shortTime(it.Timestamp)[5:],
			ui.Truncate(it.Model, 26),
			st,
			ui.Tokens(total),
			cached,
			ttft,
			duration(it.LatencyMs),
		})
	}
	return ui.Table([]string{"时间", "模型", "状态", "Token", "缓存读", "首字", "耗时"}, rows,
		ui.Left, ui.Left, ui.Left, ui.Right, ui.Right, ui.Right, ui.Right)
}

// duration 同控制台 fmtDuration：849ms · 1.82s · 83.7s · 412s。
func duration(ms float64) string {
	if ms < 1000 {
		return fmt.Sprintf("%dms", int(math.Round(ms)))
	}
	s := ms / 1000
	switch {
	case s < 10:
		return fmt.Sprintf("%.2fs", s)
	case s < 100:
		return fmt.Sprintf("%.1fs", s)
	default:
		return fmt.Sprintf("%ds", int(math.Round(s)))
	}
}
