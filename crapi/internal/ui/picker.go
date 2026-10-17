package ui

import (
	"fmt"
	"strings"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
)

// PickerItem 代表一个可选行项目。
type PickerItem struct {
	ID          string // 唯一标识（例如 harness ID 或 model ID）
	Title       string // 主标题（例如 "Claude Code" 或 "claude-opus-5-5"）
	Subtitle    string // 副标题/当前模型（例如 "[当前: opus[1m]]" 或 "Anthropic (1M ctx)"）
	CurrentTag  string // 标记（例如 "[当前生效]"）
	SearchWords string // 供搜索匹配的文本
}

// PickerStage 交互阶段
type PickerStage int

const (
	StageHarness PickerStage = iota
	StageModel
)

// ModelPickerConfig 配置
type ModelPickerConfig struct {
	Version         string
	BaseURL         string
	Harnesses       []PickerItem
	Models          []PickerItem
	ApplyFunc       func(harnessID, modelID string) error
	InitialStage    PickerStage
	TargetHarnessID string
}

type pickerModel struct {
	cfg             ModelPickerConfig
	stage           PickerStage
	harnessItems    []PickerItem
	modelItems      []PickerItem
	filteredHarness []PickerItem
	filteredModels  []PickerItem
	selectedHarness PickerItem
	cursor          int
	harnessCursor   int // 记录离开 Harness 列表时光标所在的精确位置，确保 Esc 返回时完美保留
	searchQuery     string
	message         string
	messageIsErr    bool
	width           int
	height          int
	quitting        bool
	updatedCount    int
}

func (m *pickerModel) Init() tea.Cmd {
	m.refilterHarnesses()
	m.refilterModels()
	if m.cfg.InitialStage == StageModel && m.cfg.TargetHarnessID != "" {
		for _, h := range m.harnessItems {
			if h.ID == m.cfg.TargetHarnessID {
				m.selectedHarness = h
				m.stage = StageModel
				break
			}
		}
	}
	return nil
}

func (m *pickerModel) refilterHarnesses() {
	if m.searchQuery == "" {
		m.filteredHarness = m.harnessItems
		return
	}
	q := strings.ToLower(m.searchQuery)
	var res []PickerItem
	for _, it := range m.harnessItems {
		if strings.Contains(strings.ToLower(it.Title), q) ||
			strings.Contains(strings.ToLower(it.ID), q) ||
			strings.Contains(strings.ToLower(it.Subtitle), q) {
			res = append(res, it)
		}
	}
	m.filteredHarness = res
}

func (m *pickerModel) refilterModels() {
	if m.searchQuery == "" {
		m.filteredModels = m.modelItems
		return
	}
	q := strings.ToLower(m.searchQuery)
	var res []PickerItem
	for _, it := range m.modelItems {
		match := strings.Contains(strings.ToLower(it.Title), q) ||
			strings.Contains(strings.ToLower(it.Subtitle), q) ||
			strings.Contains(strings.ToLower(it.SearchWords), q)
		if match {
			res = append(res, it)
		}
	}
	m.filteredModels = res
}

func (m *pickerModel) currentList() []PickerItem {
	if m.stage == StageHarness {
		return m.filteredHarness
	}
	return m.filteredModels
}

func (m *pickerModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		return m, nil

	case tea.KeyPressMsg:
		key := msg.String()
		switch key {
		case "ctrl+c":
			m.quitting = true
			return m, tea.Quit

		case "esc":
			if m.stage == StageModel {
				if m.searchQuery != "" {
					m.searchQuery = ""
					m.refilterModels()
					m.cursor = 0
					return m, nil
				}
				// 如果原本直接针对单一 harness 运行，则 Esc 直接退出
				if m.cfg.InitialStage == StageModel && m.cfg.TargetHarnessID != "" {
					m.quitting = true
					return m, tea.Quit
				}
				// 原地返回到选择工具阶段，并完美恢复之前所在的光标位置
				m.stage = StageHarness
				m.searchQuery = ""
				m.refilterHarnesses()
				m.cursor = m.harnessCursor
				if m.cursor >= len(m.filteredHarness) {
					m.cursor = len(m.filteredHarness) - 1
				}
				if m.cursor < 0 {
					m.cursor = 0
				}
				return m, nil
			}
			// StageHarness 阶段按 Esc：退出
			if m.searchQuery != "" {
				m.searchQuery = ""
				m.refilterHarnesses()
				m.cursor = 0
				return m, nil
			}
			m.quitting = true
			return m, tea.Quit

		case "up":
			if m.cursor > 0 {
				m.cursor--
			}
			return m, nil

		case "down":
			list := m.currentList()
			if m.cursor < len(list)-1 {
				m.cursor++
			}
			return m, nil

		case "backspace":
			if len(m.searchQuery) > 0 {
				m.searchQuery = m.searchQuery[:len(m.searchQuery)-1]
				if m.stage == StageHarness {
					m.refilterHarnesses()
				} else {
					m.refilterModels()
				}
				m.cursor = 0
			}
			return m, nil

		case "enter":
			list := m.currentList()
			if len(list) == 0 {
				return m, nil
			}
			selected := list[m.cursor]

			if m.stage == StageHarness {
				// 记录在 Harness 列表的光标位置，进入模型选择
				m.harnessCursor = m.cursor
				m.selectedHarness = selected
				m.stage = StageModel
				m.searchQuery = ""
				m.cursor = 0
				m.refilterModels()
				return m, nil
			}

			// StageModel：执行切换
			chosenModel := selected.ID
			if m.cfg.ApplyFunc != nil {
				err := m.cfg.ApplyFunc(m.selectedHarness.ID, chosenModel)
				if err != nil {
					m.message = fmt.Sprintf("切换失败：%v", err)
					m.messageIsErr = true
				} else {
					m.updatedCount++
					cleanModel := CleanModelName(chosenModel)
					m.message = fmt.Sprintf("成功将 [%s] 的默认模型切换为 %s", m.selectedHarness.Title, cleanModel)
					m.messageIsErr = false

					// 动态更新 harness 列表中的当前模型标记
					for i, h := range m.harnessItems {
						if m.selectedHarness.ID == "ALL" || h.ID == m.selectedHarness.ID {
							m.harnessItems[i].Subtitle = "当前: " + cleanModel
						}
					}
					m.refilterHarnesses()
				}
			}

			// 如果是单独指定单个 harness 运行，切换完成后直接退出
			if m.cfg.InitialStage == StageModel && m.cfg.TargetHarnessID != "" {
				m.quitting = true
				return m, tea.Quit
			}

			// 原地切回 Harness 列表，光标精准保持在刚才操作的那个 harness 上
			m.stage = StageHarness
			m.searchQuery = ""
			m.refilterHarnesses()
			m.cursor = m.harnessCursor
			if m.cursor >= len(m.filteredHarness) {
				m.cursor = len(m.filteredHarness) - 1
			}
			if m.cursor < 0 {
				m.cursor = 0
			}
			return m, nil

		case "tab":
			list := m.currentList()
			if m.cursor < len(list)-1 {
				m.cursor++
			} else {
				m.cursor = 0
			}
			return m, nil

		case "shift+tab":
			list := m.currentList()
			if m.cursor > 0 {
				m.cursor--
			} else if len(list) > 0 {
				m.cursor = len(list) - 1
			}
			return m, nil

		case "ctrl+u":
			if m.searchQuery != "" {
				m.searchQuery = ""
				if m.stage == StageHarness {
					m.refilterHarnesses()
				} else {
					m.refilterModels()
				}
				m.cursor = 0
			}
			return m, nil

		case "space":
			m.searchQuery += " "
			if m.stage == StageHarness {
				m.refilterHarnesses()
			} else {
				m.refilterModels()
			}
			m.cursor = 0
			return m, nil

		default:
			// 输入任意可打印字符进行实时搜索过滤
			if msg.Text != "" && !strings.ContainsAny(msg.Text, "\r\n\t\x1b\x00") {
				m.searchQuery += msg.Text
				if m.stage == StageHarness {
					m.refilterHarnesses()
				} else {
					m.refilterModels()
				}
				m.cursor = 0
				return m, nil
			}
		}
	}
	return m, nil
}

func (m *pickerModel) View() tea.View {
	if m.quitting {
		v := tea.NewView("")
		v.AltScreen = false
		return v
	}

	var b strings.Builder

	// 1. 顶部 Header
	headerStyle := lipgloss.NewStyle().
		Bold(true).
		Foreground(Brand).
		Padding(0, 1)

	b.WriteString("\n")
	b.WriteString(headerStyle.Render("◆ crapi · Crosery CPA 默认模型管理"))
	b.WriteString("  " + Dim.Render(m.cfg.Version) + "\n\n")

	// 2. 状态/操作导航说明
	if m.stage == StageHarness {
		b.WriteString(Bold.Render("请选择要查看或切换的 Agent Harness：\n"))
		b.WriteString(Dim.Render("  ↑/↓ 移动光标  ·  输入字符过滤  ·  Enter 进入选模型  ·  Esc 退出\n\n"))
	} else {
		targetName := m.selectedHarness.Title
		b.WriteString(Bold.Render(fmt.Sprintf("为 【%s】 选择新的默认主流模型：\n", AccentS.Render(targetName))))
		b.WriteString(Dim.Render("  ↑/↓ 移动光标  ·  直接打字实时搜索  ·  Enter 确认切换  ·  Esc 返回工具列表\n\n"))
	}

	// 3. 搜索栏
	searchPrompt := "搜索过滤: "
	if m.searchQuery != "" {
		b.WriteString("  " + Bold.Render(searchPrompt) + BrandS.Render(m.searchQuery) + " ▌\n\n")
	} else {
		b.WriteString("  " + Dim.Render(searchPrompt+"输入关键字实时搜索...") + "\n\n")
	}

	// 4. 列表渲染（视口高度自动适配）
	list := m.currentList()
	maxItems := 12
	if m.height > 24 {
		maxItems = m.height - 12
	}
	if maxItems < 6 {
		maxItems = 6
	}

	start := 0
	if m.cursor >= maxItems {
		start = m.cursor - maxItems + 1
	}
	end := start + maxItems
	if end > len(list) {
		end = len(list)
	}

	if len(list) == 0 {
		b.WriteString("    " + Dim.Render("未找到匹配的项目，按 Backspace 删除搜索词\n"))
	} else {
		for i := start; i < end; i++ {
			it := list[i]
			isCursor := (i == m.cursor)

			prefix := "    "
			titleStyle := lipgloss.NewStyle()
			if isCursor {
				prefix = "  " + BrandS.Render("▶ ")
				titleStyle = Bold.Foreground(Brand)
			}

			title := Pad(it.Title, 26)
			sub := Dim.Render(it.Subtitle)
			tag := ""
			if it.CurrentTag != "" {
				tag = " " + OKS.Render(it.CurrentTag)
			}

			b.WriteString(fmt.Sprintf("%s%s  %s%s\n", prefix, titleStyle.Render(title), sub, tag))
		}
	}

	// 5. 底部操作提示与状态反馈
	b.WriteString("\n")
	if m.message != "" {
		if m.messageIsErr {
			b.WriteString("  " + ErrS.Render("✗ "+m.message) + "\n")
		} else {
			b.WriteString("  " + OKS.Render("✓ "+m.message) + "\n")
		}
	} else {
		b.WriteString("  " + Dim.Render(fmt.Sprintf("项目共 %d 项 · 当前光标第 %d 项", len(list), m.cursor+1)) + "\n")
	}

	v := tea.NewView(b.String())
	v.AltScreen = true
	return v
}

// CleanModelName 去除各种私有前缀，还原真实简洁的模型名称。
func CleanModelName(m string) string {
	m = strings.TrimSpace(m)
	if idx := strings.LastIndex(m, "/"); idx >= 0 {
		m = m[idx+1:]
	}
	if strings.HasPrefix(strings.ToLower(m), "custom:crosery-") {
		m = m[len("custom:crosery-"):]
	}
	if strings.HasPrefix(strings.ToLower(m), "custom:crosery:") {
		m = m[len("custom:crosery:"):]
	}
	return m
}

// RunModelPicker 启动现代化单屏交互式模型选择器。
func RunModelPicker(cfg ModelPickerConfig) (updatedCount int, err error) {
	p := &pickerModel{
		cfg:          cfg,
		stage:        cfg.InitialStage,
		harnessItems: cfg.Harnesses,
		modelItems:   cfg.Models,
	}
	prog := tea.NewProgram(p)
	_, err = prog.Run()
	return p.updatedCount, err
}
