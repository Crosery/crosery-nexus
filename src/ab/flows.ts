/**
 * A/B 实验台的三个实验对象（真实流程）+ 每个流程的**任务脚本**与**判定标准**。
 *
 * 判定标准的来源是红队审计 `docs/qa/red-team/ui-interaction-audit.md`（32 条缺陷 + TUF 14 条模式）：
 * 每条标准都写明「怎么看」，让任何人（包括用户自己）能照着走一遍、得出可比的结果。
 * 指标口径固定为六项：步数 / 点击数 / 误操作 / 卡住点 / 是否可恢复 / 需要看文档次数。
 */

import type { AbFlowId } from './preference'
import { VARIANT_PAIRS, type VariantPairKey } from './registry'

export interface AbTaskStep {
  id: string
  text: string
}

export interface AbCriterion {
  id: string
  /** 判定维度（六项口径之一） */
  metric: string
  /** 合格线：满足即算「好」，并给出看到的证据形式 */
  pass: string
  /** 与红队审计的对应关系（可追溯到具体缺陷号） */
  ref: string
}

export interface AbFlow {
  id: AbFlowId
  /** 侧栏/切换器上的短标题 */
  title: string
  /** 一句话说明这个流程在真实产品里干什么 */
  subtitle: string
  pair: VariantPairKey
  /** A/B 两侧的面板标题 */
  labels: { a: string; b: string }
  /** 任务脚本：操作者照着做一遍，不许有人口头讲解 */
  task: { title: string; steps: AbTaskStep[] }
  criteria: AbCriterion[]
  /** 迁移前后已知的能力差（读取自红队审计，用于解释差值，不作为结论） */
  gap: string
  /** 需要看文档时的文档面说明 */
  docHint?: string
}

export const AB_FLOWS: AbFlow[] = [
  {
    id: 'keys-access',
    title: '① API Key 列表：筛选 / 搜索 / 删除确认',
    subtitle: '14 个真实 Key 的日常管理：找到某一个、看它的额度、走到删除的最后一步',
    pair: 'keys',
    labels: { a: 'A · 迁移前 KeysPage（281c30e 冻结副本）', b: 'B · 迁移后 KeysPage（当前真实页面）' },
    task: {
      title: '任务脚本：给新同事做一次 Key 体检（照做即可，不需要讲解）',
      steps: [
        { id: 'k1', text: '打开本流程，说出当前一共几个 Key、其中几个已停用。' },
        { id: 'k2', text: '用搜索框把列表缩到只包含关键词「非」的 Key；再切一个筛选条件，说出结果行数。' },
        { id: 'k3', text: '刷新页面：搜索词和筛选还在吗？把当前地址复制给同事，他打开后看到的是不是同一份结果？' },
        { id: 'k4', text: '找到 Key「非雨」，打开它的额度设置，读出日 / 周 / 总计限额和「今日已用」。' },
        { id: 'k5', text: '走到「删除这个 Key」的最后一步确认框，确认它删的是哪一个 Key，然后取消（不要真的删）。' },
      ],
    },
    criteria: [
      {
        id: 'k-c1',
        metric: '误操作',
        pass: '删除确认框单独出现、写清目标 Key 名；不会叠在「编辑 Key」弹窗之上（两层遮罩同时可见即判失败）。',
        ref: 'D8 / M1',
      },
      {
        id: 'k-c2',
        metric: '卡住点 / 可分享性',
        pass: '搜索与筛选写进 URL；刷新后结果保持；把地址发给同事，对方看到同一份筛选结果（界面里刷新即丢即判失败）。',
        ref: 'D13 / M6 / M7',
      },
      {
        id: 'k-c3',
        metric: '误操作',
        pass: '额度重置这类不可逆动作在执行前有确认框，且确认文案写清重置的是「今日 / 本周 / 总计」哪一档。',
        ref: 'D5 / D26',
      },
      {
        id: 'k-c4',
        metric: '步数 / 卡住点',
        pass: '主标识（Key 名）可点、可键盘聚焦、能打开详情；不需要靠找一个没有名字的图标按钮。',
        ref: 'D21 / M8',
      },
      {
        id: 'k-c5',
        metric: '误操作',
        pass: '接口失败时页面留下**持久**错误说明 + 重试入口；不会显示成「这个账号一个 Key 都没有」。',
        ref: 'D2 / M2 / M3',
      },
      {
        id: 'k-c6',
        metric: '卡住点',
        pass: '390px 窄屏下列名与单元格不再重叠到不可读（列宽塌成 0px 即判失败）。',
        ref: 'D4',
      },
    ],
    gap: '迁移前：删除确认叠在编辑弹窗上（D8）、筛选不进 URL（D13）、重置额度零确认（D5）、主标识死点击（D21）、故障退化成空数据（D2）、移动端列宽塌陷（D4）。',
  },
  {
    id: 'integration-rtk',
    title: '② 接入与 RTK 配置',
    subtitle: '把一个 agent（Codex）接入网关，并确认 / 打开 RTK token 压缩',
    pair: 'integration',
    labels: { a: 'A · 迁移前 接入面（OAuth 登录池，281c30e 冻结副本）', b: 'B · 迁移后 接入面（当前 OAuthPage，下含新增 RTK 面）' },
    task: {
      title: '任务脚本：把新装的 Codex 接进来，并确认 RTK 是否在省 token',
      steps: [
        { id: 'r1', text: '在控制台里找到「这台机器要接入网关，下一步该敲什么命令」。' },
        { id: 'r2', text: '说出当前 Codex 的 RTK token 压缩是否已开启；如果已开启，省了多少钱 / 多少 token。' },
        { id: 'r3', text: '如果没开启，打开它，并在**不刷新页面**的前提下确认状态真的变成了「已开启」。' },
        { id: 'r4', text: '找到「接入完成后怎么验证连通」的说明；判断这条说明离操作点有多远（同屏 / 要点一次 / 只能去帮助页翻）。' },
        { id: 'r5', text: '如果某一步失败（例如平面不支持），说出页面有没有告诉你为什么、下一步做什么。' },
      ],
    },
    criteria: [
      {
        id: 'r-c1',
        metric: '需要看文档次数',
        pass: '接入命令与控制台内可复制的下一步在同一个界面里能拿到；不需要离开当前页去帮助文档翻找（翻文档记 1 次）。',
        ref: 'D17 / D18 / M5',
      },
      {
        id: 'r-c2',
        metric: '卡住点 / 是否可恢复',
        pass: 'RTK 开关的结果能从**页面状态**读出来（不是一闪而过的 toast），失败时有原因与下一步。',
        ref: 'D2 / M2 / M3',
      },
      {
        id: 'r-c3',
        metric: '误操作',
        pass: '会影响真实 token 计费的开关在执行前有明确确认或明确说明影响面，而不是拨一下就直接生效。',
        ref: 'D27 / M1',
      },
      {
        id: 'r-c4',
        metric: '卡住点',
        pass: '同一实体在同一屏里只有一个叫法（例如「渠道 / 渠道账号 / 中转站」只出现一种）。',
        ref: 'D30',
      },
      {
        id: 'r-c5',
        metric: '是否可恢复',
        pass: '长时等待/轮询有上限与超时提示，不会无限期停在「等待授权」。',
        ref: 'D24',
      },
    ],
    gap: '迁移前：控制台里没有任何 RTK 状态 / 开关面，接入说明只存在于帮助页；开关类操作无确认、无持久结果（D27 / D2 / D24 / D30）。',
    docHint: 'A 侧唯一的接入说明来源是「迁移前帮助页」（已冻结）；B 侧是当前帮助页 + B 侧新增的 RTK 配置页。',
  },
  {
    id: 'dashboard-overview',
    title: '③ 运行概览 Dashboard 首屏',
    subtitle: '不翻页、不查文档，10 秒内读出「花了多少 / 错没错 / 谁在跑」',
    pair: 'dashboard',
    labels: { a: 'A · 迁移前 DashboardPage（281c30e 冻结副本）', b: 'B · 迁移后 DashboardPage（当前真实页面）' },
    task: {
      title: '任务脚本：早上一眼确认服务是否健康',
      steps: [
        { id: 'd1', text: '打开首屏，10 秒内说出：近 7 天请求量、Token 消耗、错误率、平均响应时间。' },
        { id: 'd2', text: '判断网关现在是健康还是异常，并说出你的依据来自哪个数字或哪句话。' },
        { id: 'd3', text: '找出最活跃的 Key，说出它这段时间大概花了多少钱。' },
        { id: 'd4', text: '检查首屏有没有同一个量级两种单位（例如「7.7万」和「76.8k」并存），缺值是否出现「n/a / 未定价 / —」混用。' },
        { id: 'd5', text: '如果接口挂了（可断网或看错误态），说出页面会不会把「故障」显示成「健康 / 0」。' },
      ],
    },
    criteria: [
      {
        id: 'd-c1',
        metric: '步数',
        pass: '四个核心数字都在首屏（不需要滚动到第二屏、不需要切时间范围就能读到）。',
        ref: 'D12 / M4',
      },
      {
        id: 'd-c2',
        metric: '误操作 / 卡住点',
        pass: '数字与它背后的接口同源：页面上看到的请求量 / Token / 延迟，与在同一个页面里 fetch `/api/dashboard?days=7` 的返回一致；不出现「接口有值、页面显示 0 或 —」。',
        ref: 'D1 / M2 / M14',
      },
      {
        id: 'd-c3',
        metric: '卡住点',
        pass: '同一量级只用一种单位、金额与百分比的缺失值只有一种写法。',
        ref: 'D16 / M10',
      },
      {
        id: 'd-c4',
        metric: '是否可恢复',
        pass: '取数失败时首屏给出错误 + 重试，而不是静默渲染成 0 或空列表。',
        ref: 'D2 / M3',
      },
      {
        id: 'd-c5',
        metric: '卡住点',
        pass: '加载态是受控骨架（有数据就消失），不会永久停在「加载中」。',
        ref: 'D3 / M4',
      },
    ],
    gap: '迁移前：请求明细取数错配导致错误率恒 0（D1）、失败态静默（D2）、单位/缺值多套并存（D16）、无骨架加载态（M4 缺失）。',
  },
]

export const findFlow = (id: AbFlowId): AbFlow => AB_FLOWS.find((flow) => flow.id === id) || AB_FLOWS[0]

export const flowPair = (flow: AbFlow) => VARIANT_PAIRS[flow.pair]

/** 六项固定指标口径，页面上原样展示，避免「好」的定义漂移。 */
export const AB_METRICS = ['步数', '点击数', '误操作', '卡住点', '是否可恢复', '需要看文档次数'] as const
