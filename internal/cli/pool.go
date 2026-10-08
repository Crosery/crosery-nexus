package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/crosery/crapi/internal/api"
	"github.com/crosery/crapi/internal/ui"
)

const poolHelp = `crapi pool [--json]

查看 Crosery 号池状态：每个渠道的账号数、运行 / 冷却 / 异常 / 暂停数量，
以及 Claude、Codex 等订阅账号在各额度窗口（5 小时 / 每周）的平均占用与重置时间。
按渠道分层显示，渠道名与顺序同控制台的订阅账号池。
数据为脱敏聚合，不含任何账号标识。`

func cmdPool(a *App, args []string) error {
	fs := newFlags("pool", poolHelp)
	asJSON := fs.Bool("json", false, "")
	if _, err := parse(fs, args, poolHelp); err != nil {
		return err
	}
	c, err := a.client()
	if err != nil {
		return err
	}
	var pool *api.Pool
	var models []api.Model
	load := func(ctx context.Context) error {
		var err error
		pool, err = c.GetPool(a.ctx)
		if errors.Is(err, api.ErrUnsupported) {
			pool = nil
			err = nil
		}
		if err != nil {
			return err
		}
		models, err = c.ListModels(a.ctx)
		return err
	}
	if *asJSON {
		if err := load(a.ctx); err != nil {
			return err
		}
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(pool)
	}
	if err := ui.Spin("正在读取号池状态…", load); err != nil {
		return err
	}
	if pool == nil {
		ui.Section("号池状态")
		ui.Warn("控制台暂未开放号池接口，先展示各渠道的在线模型。")
		return cmdChannelsFrom(models)
	}
	renderPool(pool)
	return nil
}

func renderPool(p *api.Pool) {
	total := poolTotal(p)
	hint := fmt.Sprintf("%d 个渠道 · %d 个账号", len(p.Providers), total.Total)
	if p.GeneratedAt != "" {
		hint += " · " + shortTime(p.GeneratedAt)
	}
	ui.Section("号池状态", hint)
	ui.Println(ui.Tree(poolTree(p)))
	if p.QuotaAsOf != nil && *p.QuotaAsOf != "" {
		ui.Println()
		ui.Note("额度窗口数据更新于 %s", shortTime(*p.QuotaAsOf))
	}
}

func poolTotal(p *api.Pool) api.PoolAccounts {
	total := api.PoolAccounts{}
	for _, pr := range p.Providers {
		total.Total += pr.Accounts.Total
		total.Active += pr.Accounts.Active
		total.Cooling += pr.Accounts.Cooling
		total.Disabled += pr.Accounts.Disabled
		total.Error += pr.Accounts.Error
	}
	return total
}

// poolTree：全部 → 各渠道（顺序与控制台订阅账号池一致）→ 账号状态、额度窗口、模型。
func poolTree(p *api.Pool) []ui.TreeNode {
	g := ui.G()
	total := poolTotal(p)
	nodes := []ui.TreeNode{{Cells: []string{ui.Bold.Render("全部"), accountsBar(total, 30), accountsLegend(total)}, Kind: "total"}}

	providers := append([]api.PoolProvider(nil), p.Providers...)
	sort.SliceStable(providers, func(i, j int) bool {
		ri, rj := channelRank(providers[i].Provider), channelRank(providers[j].Provider)
		if ri != rj {
			return ri < rj
		}
		return providers[i].Accounts.Total > providers[j].Accounts.Total
	})
	for _, pr := range providers {
		label := pr.Label
		if label == "" {
			label = channelName(pr.Provider)
		}
		health := ui.OKS.Render(g.Dot + " 正常")
		switch {
		case pr.Accounts.Total == 0 || pr.Accounts.Active == 0:
			health = ui.ErrS.Render(g.Dot + " 无可用账号")
		case float64(pr.Accounts.Active)/float64(pr.Accounts.Total) < 0.5:
			health = ui.WarnS.Render(g.Dot + " 紧张")
		}
		node := ui.TreeNode{Cells: append(channelHead(label, pr.Provider), health)}
		node.Children = append(node.Children, ui.TreeNode{Cells: []string{"账号", accountsBar(pr.Accounts, 24), accountsLegend(pr.Accounts)}, Kind: "meter"})
		for _, w := range pr.Windows {
			rest := fmt.Sprintf("%3.0f%%", w.UsedPercent)
			if w.Accounts > 0 {
				rest += ui.Dim.Render(fmt.Sprintf(" · %d 个账号平均", w.Accounts))
			}
			if w.ResetsAt != nil && *w.ResetsAt != "" {
				rest += ui.Dim.Render(" · " + untilReset(*w.ResetsAt) + "后重置")
			}
			node.Children = append(node.Children, ui.TreeNode{Cells: []string{w.Label, ui.Bar(w.UsedPercent/100, 24), rest}, Kind: "meter"})
		}
		if len(pr.Models) > 0 {
			node.Children = append(node.Children, ui.TreeNode{Cells: []string{ui.Dim.Render("模型"), ui.Truncate(strings.Join(pr.Models, ", "), 90)}, Kind: "models"})
		}
		nodes = append(nodes, node)
	}
	return nodes
}

// accountsBar 用分段色条表示「运行 / 冷却 / 异常 / 暂停」的比例。
func accountsBar(a api.PoolAccounts, width int) string {
	if a.Total <= 0 {
		return ui.Bar(0, width)
	}
	g := ui.G()
	seg := func(n int) int { return int(float64(n)/float64(a.Total)*float64(width) + 0.5) }
	active, cooling, errN := seg(a.Active), seg(a.Cooling), seg(a.Error)
	disabled := width - active - cooling - errN
	if disabled < 0 {
		active += disabled
		disabled = 0
	}
	return ui.OKS.Render(strings.Repeat(g.BarFull, active)) +
		ui.WarnS.Render(strings.Repeat(g.BarFull, cooling)) +
		ui.ErrS.Render(strings.Repeat(g.BarFull, errN)) +
		ui.Dim.Render(strings.Repeat(g.BarEmpty, disabled))
}

func accountsLegend(a api.PoolAccounts) string {
	// 状态名同控制台订阅账号池（src/features/accounts/model.ts viewOf）
	parts := []string{ui.OKS.Render(fmt.Sprintf("运行 %d", a.Active))}
	if a.Cooling > 0 {
		parts = append(parts, ui.WarnS.Render(fmt.Sprintf("冷却 %d", a.Cooling)))
	}
	if a.Error > 0 {
		parts = append(parts, ui.ErrS.Render(fmt.Sprintf("异常 %d", a.Error)))
	}
	if a.Disabled > 0 {
		parts = append(parts, ui.Dim.Render(fmt.Sprintf("暂停 %d", a.Disabled)))
	}
	return strings.Join(parts, ui.Dim.Render(" · ")) + ui.Dim.Render(fmt.Sprintf(" / 共 %d", a.Total))
}

// cmdChannelsFrom 在没有号池接口时退化为按渠道展示模型。
func cmdChannelsFrom(models []api.Model) error {
	ui.Println(ui.Tree(channelTree(groupByChannel(models))))
	return nil
}
