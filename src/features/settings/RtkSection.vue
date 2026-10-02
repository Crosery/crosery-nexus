<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { TxButton } from '@talex-touch/tuffex/button'
import { TxCollapse, TxCollapseItem } from '@talex-touch/tuffex/collapse'
import { TxTag } from '@talex-touch/tuffex/tag'
import Plate from '../../ui/data/Plate.vue'
import StatusMark from '../../ui/data/StatusMark.vue'
import Switch from '../../ui/form/Switch.vue'
import Spark from '../../ui/viz/Spark.vue'
import StateBlock from '../../ui/data/StateBlock.vue'
import { api, RtkApiError } from '../../api'
import { errorMessage, errorStatus } from '../../lib/errors'
import { confirmSheet } from '../../ui/feedback/confirmSheet'
import { copyText, notify } from '../../ui/feedback/toast'
import { dayKey, fmtCompact, fmtInt, fmtTime } from '../../ui/fmt'
import type { DataState, StatusKind } from '../../ui/types'
import type { RTKStatusResponse, RtkAgentStatus, RtkAutoView, RtkGlobalStatus, RtkPlaneProbe, VersionsData } from '../../types'
import { PLANE_WORD, RTK_BINARY_VERB, RTK_REASON_WORD, rtkApplyNotice, rtkBinaryNotice, rtkConfirmFacts, rtkDailySeries, rtkDirections, rtkWords, type RtkBinaryAction } from './settingsModel'

/**
 * 02 RTK (#rtk, DESIGN §6.8, CONTRACTS C4): ONE global switch. It bulk-applies the existing per-client hook
 * toggle on the resolved plane (kernel → relay → local), so the confirm sheet says exactly that and names the
 * clients it will touch. Plane status, raw codes, the client list (once) and the rollback list live in the
 * collapsed 诊断 disclosure (TxCollapse), loaded only when opened (or when the confirm needs the client names).
 */
const props = defineProps<{
  global: RtkGlobalStatus | undefined
  state: DataState
  error: unknown
  lastAt: number | null
  versions: VersionsData | undefined
  /** 「自动升级」 (/api/autoupdate → rtk): the scheduled job upgrades the rtk program itself; null = not read yet */
  auto?: RtkAutoView | null
  autoBusy?: boolean
}>()
const emit = defineEmits<{ retry: []; refresh: []; auto: [on: boolean] }>()
const autoMark = computed(() => (props.auto?.tone === 'bad' ? '◆ ' : props.auto?.tone === 'warn' ? '◇ ' : ''))

const words = computed(() => (props.global ? rtkWords(props.global) : null))
/* mixed: the switch alone can only ask for 全部开启, so both directions are offered as explicit actions */
const directions = computed(() => (props.global && words.value ? rtkDirections(words.value, props.global.writable) : []))
function copyInstall() {
  if (words.value?.install) void copyText(words.value.install, '安装命令')
}
const mark = computed<{ state: StatusKind; label: string }>(() => {
  const w = words.value
  if (!w) return { state: 'stale', label: '未知' }
  if (w.state === 'on') return { state: 'run', label: '已开启' }
  if (w.state === 'off') return { state: 'off', label: '已关闭' }
  if (w.state === 'mixed') return { state: 'pause', label: `部分开启 ${w.coverage}` }
  return { state: 'stale', label: '未知' }
})
const rtkVersion = computed(() => props.versions?.cpa.rtk?.version ?? null)
const series = computed(() => {
  const days = props.versions?.cpa.rtk?.days
  if (!days?.length) return null
  const out = rtkDailySeries(days, dayKey(Date.now()), 14)
  const top = days.filter((day) => out.dates.includes(day.date)).sort((a, b) => b.saved - a.saved)[0]
  return { ...out, peak: top && top.saved > 0 ? `${top.date.slice(5).replace('-', '/')} · ${fmtCompact(top.saved)} tok` : null }
})
const planeLine = computed(() => {
  const plane = props.global?.plane
  if (plane === 'local') return '控制台所在机器'
  if (plane === 'kernel') return '网关内核的沙箱 HOME'
  if (plane === 'relay') return '远端中转站'
  return '没有可用平面'
})

/* ── diagnostics (lazy) ───────────────────────────────────────────── */
const diag = ref<RTKStatusResponse | null>(null)
const diagError = ref<unknown>(null)
const diagLoading = ref(false)
const diagState = computed<DataState>(() => (diag.value ? 'ready' : diagError.value ? 'error' : 'loading'))
async function loadDiag() {
  if (diagLoading.value) return
  diagLoading.value = true
  try {
    diag.value = await api.getRTKStatus()
    diagError.value = null
  } catch (error) {
    diagError.value = error
  } finally {
    diagLoading.value = false
  }
}
/** TxCollapse model: `['diag']` when open. The body mounts on first open and the status loads then. */
const diagOpen = ref<string[]>([])
const diagSeen = ref(false)
watch(diagOpen, (open) => {
  if (!open.includes('diag')) return
  diagSeen.value = true
  if (!diag.value) void loadDiag()
})

const PLANE_STATE: Record<string, { state: StatusKind; label: string }> = {
  available: { state: 'run', label: '已接通' },
  degraded: { state: 'warn', label: '可用 · 未装 rtk' },
  not_configured: { state: 'idle', label: '未配置' },
  unreachable: { state: 'stale', label: '不可达' },
  unauthorized: { state: 'bad', label: '凭据被拒' },
  not_supported: { state: 'idle', label: '无 RTK 接口' },
}
const planeRows = computed(() =>
  (diag.value?.planes ?? []).map((plane: RtkPlaneProbe) => ({
    ...plane,
    word: PLANE_WORD[plane.id] ?? plane.id,
    mark: PLANE_STATE[plane.state] ?? { state: 'stale' as StatusKind, label: plane.state },
    current: diag.value?.plane === plane.id,
  })),
)
function agentWord(agent: RtkAgentStatus): { state: StatusKind; label: string } {
  if (agent.blocked === 'project_scoped_only' || !agent.supported) return { state: 'idle', label: '仅项目级' }
  if (agent.installed === false) return { state: 'idle', label: '未安装' }
  return agent.on ? { state: 'run', label: '已挂载' } : { state: 'pause', label: '未挂载' }
}
const agentRows = computed(() => (diag.value?.agents ?? []).map((agent) => ({ agent, ...agentWord(agent) })))
const writeMode = computed(() => {
  const mode = diag.value?.writeMode
  return mode === 'off' ? '全只读' : mode === 'confirm' ? '需确认' : mode === 'local' ? '本机可写' : '—'
})

/* ── actions ──────────────────────────────────────────────────────── */
const busy = ref(false)

async function ask(target: boolean) {
  const g = props.global
  if (!g || busy.value) return
  if (!diag.value) await loadDiag()
  const plane = g.plane ? PLANE_WORD[g.plane] ?? g.plane : '当前平面'
  const ok = await confirmSheet({
    title: target ? '全部开启 RTK？' : '全部关闭 RTK？',
    body: `会在${plane}改写这些客户端的 hooks 配置：${target ? '挂载 rtk 钩子，命令输出先压缩再进上下文' : '卸载 rtk 钩子，恢复原样输出'}。`,
    facts: rtkConfirmFacts(g, target, diag.value?.agents ?? null),
    consequence: '只改 rtk 自己那一条 · 改完重启客户端才生效',
    confirmText: target ? '全部开启' : '全部关闭',
  })
  if (!ok) return
  busy.value = true
  try {
    const result = await api.rtkGlobal.set(target)
    const notice = rtkApplyNotice(result, target)
    notify(notice.title, { tone: notice.tone, description: notice.description, id: 'cx-rtk' })
  } catch (error) {
    const code = (error as { code?: string | null }).code ?? (error instanceof RtkApiError ? error.reason : undefined)
    if (code === 'global_apply_running') notify('— 另一次切换正在进行', { tone: 'note', id: 'cx-rtk' })
    else notify(`◆ RTK 未改动 · ${(code && RTK_REASON_WORD[code]) || errorMessage(error) || '请求失败'}`, { tone: 'bad', id: 'cx-rtk' })
  } finally {
    busy.value = false
    emit('refresh')
    if (diag.value) void loadDiag()
  }
}

async function rollback(backup: { id: string; at: string; fileCount: number }) {
  const ok = await confirmSheet({
    title: '回退到这次备份？',
    facts: [
      { k: '备份', v: backup.id },
      { k: '时间', v: fmtTime(backup.at) },
      { k: '文件', v: `${fmtInt(backup.fileCount)} 个` },
    ],
    consequence: '用备份覆盖当前客户端配置 · 备份时不存在的文件会被删除',
    confirmText: '回退',
    danger: true,
  })
  if (!ok) return
  busy.value = true
  try {
    const result = await api.rollbackRTK(backup.id)
    notify(`✓ 已回退 · 恢复 ${fmtInt(result.restored.length)} 个文件`, { tone: 'ok', id: 'cx-rtk' })
  } catch (error) {
    notify(`◆ 回退失败 · ${errorMessage(error) || '请求失败'}`, { tone: 'bad', id: 'cx-rtk' })
  } finally {
    busy.value = false
    emit('refresh')
    void loadDiag()
  }
}

/* 安装 / 升级 the rtk program on the resolved plane: the server forwards it only where that seam exists
   (中转站 with remote writes on); 本机 and 内核 answer 501 with the manual command, shown in the toast. */
async function binary(action: RtkBinaryAction) {
  if (busy.value) return
  const verb = RTK_BINARY_VERB[action]
  const g = props.global
  const plane = g?.plane ? PLANE_WORD[g.plane] ?? g.plane : '当前平面'
  const ok = await confirmSheet({
    title: `${verb} rtk？`,
    body: `在${plane}${verb} rtk 程序。本机与内核平面不由控制台代为执行，会给出手动命令。`,
    facts: [
      { k: '平面', v: plane },
      { k: '当前版本', v: rtkVersion.value ?? '—' },
    ],
    consequence: '替换 rtk 可执行文件 · 不改客户端 hooks',
    confirmText: verb,
  })
  if (!ok) return
  busy.value = true
  try {
    await (action === 'install' ? api.installRTK({ confirm: true }) : api.upgradeRTK({ confirm: true }))
    const notice = rtkBinaryNotice(action, { ok: true })
    notify(notice.title, { tone: notice.tone, id: 'cx-rtk' })
  } catch (error) {
    const notice = rtkBinaryNotice(action, { status: errorStatus(error), reason: error instanceof RtkApiError ? error.reason : null, message: errorMessage(error) })
    notify(notice.title, { tone: notice.tone, description: notice.description, id: 'cx-rtk' })
  } finally {
    busy.value = false
    emit('refresh')
    if (diag.value) void loadDiag()
  }
}
</script>

<template>
  <Plate
    id="rtk"
    title="RTK"
    class="set-sec"
    :state="state"
    :error="error"
    :stale-at="lastAt"
    :rows="3"
    flush
    @retry="emit('retry')"
  >
    <template #meta>
      <span v-if="rtkVersion" class="num">rtk {{ rtkVersion }}</span>
    </template>
    <template v-if="global && words">
      <div class="set-rtk">
        <div class="set-rtk__sw" :class="`is-${words.state}`">
          <Switch
            :model-value="global.on === true"
            :disabled="!global.writable || busy"
            :loading="busy"
            :aria-label="`RTK 全局开关 · ${mark.label}`"
            @update:model-value="ask"
          />
          <div class="set-rtk__swt">
            <p class="set-rtk__title"><b>全局开关</b><StatusMark :state="mark.state" :label="mark.label" /></p>
            <p class="set-rtk__desc">在{{ words.plane }}给 {{ global.agents.supported }} 个客户端挂 rtk 钩子 · 命令输出先压缩再进上下文 · 关闭即全部卸载</p>
            <p v-if="words.blocked" class="set-rtk__blocked"><span aria-hidden="true">⊘</span> {{ words.blocked }}</p>
            <p v-if="words.install" class="set-rtk__install">
              <span class="dim">手动安装</span><code>{{ words.install }}</code>
              <TxButton size="sm" variant="secondary" @click="copyInstall">复制</TxButton>
            </p>
            <div v-if="directions.length" class="set-rtk__dirs" role="group" aria-label="部分开启 · 选择方向">
              <TxButton v-for="d in directions" :key="d.label" size="sm" variant="secondary" :disabled="busy" @click="ask(d.target)">{{ d.label }}</TxButton>
            </div>
          </div>
        </div>
        <dl class="set-rtk__facts">
          <div>
            <dt>平面</dt>
            <dd class="set-rtk__v num">{{ words.plane }}</dd>
            <dd class="set-rtk__sub">{{ planeLine }}</dd>
          </div>
          <div>
            <dt>覆盖</dt>
            <dd class="set-rtk__v num">{{ words.coverage }}<span class="set-rtk__unit">客户端</span></dd>
            <dd class="set-rtk__sub">已挂载 / 可切换</dd>
          </div>
          <div>
            <dt>累计节省</dt>
            <dd class="set-rtk__v num">{{ words.savings ?? '—' }}<span v-if="words.savings" class="set-rtk__unit">tok</span></dd>
            <dd class="set-rtk__sub">{{ words.savingsPct ? `输入的 ${words.savingsPct} · rtk gain` : '还没有记录' }}</dd>
          </div>
          <div v-if="series" class="set-rtk__trend">
            <dt>近 14 天</dt>
            <dd class="set-rtk__spark"><Spark :values="series.values" fluid area :h="24" :w="160" label="近 14 天每日节省 token" /></dd>
            <dd class="set-rtk__sub">{{ series.peak ? `峰值 ${series.peak}` : '近 14 天没有记录' }}</dd>
          </div>
        </dl>
      </div>

      <div v-if="auto" class="set-rtk-auto">
        <Switch
          :model-value="auto.enabled"
          :disabled="!auto.available || autoBusy"
          :loading="autoBusy"
          :aria-label="`rtk 自动升级 · ${auto.enabled ? '开' : '关'}`"
          @update:model-value="emit('auto', $event)"
        />
        <b class="set-rtk-auto__k">自动升级</b>
        <span class="set-rtk-auto__line" :class="`is-${auto.tone}`"><span v-if="autoMark" aria-hidden="true">{{ autoMark }}</span>{{ auto.line }}</span>
      </div>

      <TxCollapse v-model="diagOpen" class="set-diag">
        <TxCollapseItem name="diag">
          <template #title>
            <span class="set-diag__k">诊断</span>
            <span class="set-diag__hint">平面状态 · 客户端 · 备份与回退</span>
          </template>
          <template v-if="diagSeen">
            <StateBlock v-if="diagState !== 'ready'" :state="diagState" :error="diagError" :rows="4" @retry="loadDiag" />
            <div v-else-if="diag" class="set-diag__grid">
              <section class="set-diag__col" aria-label="平面">
                <h3>平面 <span class="dim">内核 → 中转站 → 本机，取第一个应答的</span></h3>
                <div v-for="p in planeRows" :key="p.id" class="set-diag__plane">
                  <div class="set-diag__row">
                    <b>{{ p.word }}</b>
                    <StatusMark :state="p.mark.state" :label="p.mark.label" />
                    <TxTag v-if="p.current" label="当前" size="sm" variant="plain" />
                    <code class="set-diag__code">{{ p.reason }}</code>
                  </div>
                  <p v-if="p.detail" class="set-diag__detail">{{ p.detail }}</p>
                </div>
                <p v-if="diag.error" class="set-diag__detail">{{ diag.error }}</p>
                <div class="set-diag__bin" role="group" aria-label="rtk 程序">
                  <span class="dim">rtk 程序{{ rtkVersion ? ` · ${rtkVersion}` : '' }}</span>
                  <TxButton size="sm" variant="secondary" :disabled="busy" @click="binary('install')">安装…</TxButton>
                  <TxButton size="sm" variant="secondary" :disabled="busy" @click="binary('upgrade')">升级…</TxButton>
                </div>
              </section>
              <section class="set-diag__col" aria-label="客户端">
                <h3>客户端 <span class="dim">{{ PLANE_WORD[diag.plane] }} · {{ agentRows.length }} 个</span></h3>
                <ul class="set-diag__agents">
                  <li v-for="a in agentRows" :key="a.agent.id">
                    <span class="ellip">{{ a.agent.name }}</span>
                    <StatusMark :state="a.state" :label="a.label" />
                  </li>
                </ul>
              </section>
              <section class="set-diag__col" aria-label="备份与回退">
                <h3>备份与回退 <span class="dim">保留 {{ diag.backupKeep }} 份 · {{ writeMode }}</span></h3>
                <ul v-if="diag.backups.length" class="set-diag__backups">
                  <li v-for="b in diag.backups" :key="b.id">
                    <span class="num">{{ fmtTime(b.at) }}</span>
                    <span class="num dim">{{ fmtInt(b.fileCount) }} 文件</span>
                    <TxButton size="sm" variant="ghost" :disabled="busy" :aria-label="`回退到 ${fmtTime(b.at)} 的备份`" @click="rollback(b)">回退</TxButton>
                  </li>
                </ul>
                <p v-else class="set-diag__detail">— 还没有备份</p>
                <ol class="set-diag__notes">
                  <li>改完重启客户端，运行中的进程不会重载 hook</li>
                  <li>首次触发时允许客户端信任 hook</li>
                  <li>验证：新会话里跑 <code>rtk gain --daily</code>，看 total_saved 是否增长</li>
                </ol>
              </section>
            </div>
          </template>
        </TxCollapseItem>
      </TxCollapse>
    </template>
  </Plate>
</template>

<style>
.set-rtk { display: grid; grid-template-columns: minmax(280px, 1.1fr) minmax(0, 2fr); gap: 0 40px; padding: 4px 0 16px; align-items: start; }
.set-rtk__sw { display: flex; gap: 14px; align-items: flex-start; }
.set-rtk__sw .ui-switch { margin-top: 1px; flex: none; }
/* the one global switch is drawn larger; mixed (some clients on) parks the knob in the middle on a quiet track */
html:root .set-rtk__sw .tuff-switch { --tuff-switch-track-width: 44px; --tuff-switch-track-height: 24px; }
html:root .set-rtk__sw .tuff-switch__thumb { width: 18px; height: 18px; top: 3px; left: 3px; }
html:root .set-rtk__sw .tuff-switch.is-active .tuff-switch__thumb { left: 23px; }
html:root .set-rtk__sw.is-mixed .tuff-switch__track { background: var(--paper-3); }
html:root .set-rtk__sw.is-mixed .tuff-switch__thumb { left: 13px; background: var(--ink-2); }
.set-rtk__swt { display: grid; gap: 4px; min-width: 0; }
.set-rtk__title { margin: 0; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.set-rtk__title b { font-size: var(--fs-md); font-weight: 600; color: var(--ink); }
.set-rtk__desc { margin: 0; font-size: var(--fs-sm); line-height: 1.55; color: var(--ink-2); }
.set-rtk__blocked { margin: 0; font-size: var(--fs-sm); color: var(--ink-2); }
.set-rtk__install { margin: 0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: var(--fs-xs); min-width: 0; }
.set-rtk__install code { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--ink); overflow-wrap: anywhere; min-width: 0; }
.set-rtk__dirs { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 4px; }
.set-rtk__facts { margin: 0; display: grid; grid-template-columns: repeat(4, max-content); justify-content: start; gap: 0 40px; }
.set-rtk__facts > div { display: grid; align-content: start; gap: 3px; min-width: 0; }
.set-rtk__facts dt { font-size: var(--fs-xs); color: var(--ink-3); }
.set-rtk__facts dd { margin: 0; }
.set-rtk__v { font-size: 18px; font-weight: 500; line-height: 1.25; color: var(--ink); white-space: nowrap; }
.set-rtk__unit { margin-left: 5px; font-size: var(--fs-xs); color: var(--ink-3); font-family: var(--font-sans); }
.set-rtk__sub { font-size: var(--fs-xs); color: var(--ink-3); white-space: nowrap; }
.set-rtk__trend { min-width: 160px; }
.set-rtk__spark { display: block; width: 160px; height: 24px; }

/* 自动升级: one row between the facts and 诊断, the same hairline as 诊断 */
.set-rtk-auto { margin: 0 -14px; padding: 9px 14px; border-top: 1px solid var(--rule); display: flex; align-items: flex-start; gap: 4px 12px; min-width: 0; }
.set-rtk-auto .ui-switch { flex: none; margin-top: 1px; }
.set-rtk-auto__k { flex: none; font-size: var(--fs-sm); font-weight: 600; color: var(--ink); line-height: 1.5; }
.set-rtk-auto__line { min-width: 0; font-size: var(--fs-sm); line-height: 1.5; color: var(--ink-2); overflow-wrap: anywhere; }
.set-rtk-auto__line.is-bad { color: var(--signal-ink); }

/* 诊断: one quiet disclosure row under the switch, its body in three columns separated by space alone */
html:root .set-diag { margin: 0 -14px; padding: 0 14px; border-top: 1px solid var(--rule); }
html:root .set-diag .tx-collapse-item__header { gap: 12px; min-height: 40px; }
html:root .set-diag .tx-collapse-item__title { display: flex; align-items: baseline; gap: 12px; min-width: 0; }
html:root .set-diag .tx-collapse-item__content-inner { padding: 0 0 6px; font-size: var(--fs-sm); line-height: 1.45; color: var(--ink); }
.set-diag__k { font-size: var(--fs-sm); font-weight: 600; color: var(--ink); }
.set-diag__hint { font-size: var(--fs-xs); color: var(--ink-3); font-weight: 400; }
.set-diag__grid { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr) minmax(0, 1fr); gap: 0 36px; padding: 2px 0 6px; }
.set-diag__col { min-width: 0; }
.set-diag__col h3 { margin: 0 0 6px; font-size: var(--fs-sm); font-weight: 600; color: var(--ink); display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.set-diag__col h3 .dim { font-weight: 400; font-size: var(--fs-xs); }
.set-diag__plane { padding: 5px 0; }
.set-diag__row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: var(--fs-sm); color: var(--ink); }
.set-diag__row b { font-weight: 600; min-width: 3em; }
.set-diag__code { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--ink-3); background: none; padding: 0; overflow-wrap: anywhere; }
.set-diag__bin { margin: 10px 0 0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: var(--fs-xs); }
.set-diag__detail { margin: 2px 0 0; font-size: var(--fs-xs); line-height: 1.5; color: var(--ink-2); overflow-wrap: anywhere; }
.set-diag__agents { margin: 0; padding: 0; list-style: none; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 20px; }
.set-diag__agents li { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 28px; font-size: var(--fs-sm); color: var(--ink); min-width: 0; }
.set-diag__agents .ui-st { font-size: var(--fs-xs); flex: none; }
.set-diag__backups { margin: 0; padding: 0; list-style: none; }
.set-diag__backups li { display: flex; align-items: center; gap: 12px; min-height: 32px; font-size: var(--fs-sm); color: var(--ink); }
html:root .set-diag__backups .tx-button { margin-left: auto; }
.set-diag__notes { margin: 10px 0 0; padding-left: 18px; display: grid; gap: 3px; font-size: var(--fs-xs); line-height: 1.5; color: var(--ink-2); }
.set-diag__notes code { font-family: var(--font-mono); font-size: var(--fs-xs); }

@media (max-width: 1179px) {
  .set-rtk { grid-template-columns: minmax(0, 1fr); gap: 16px; }
  .set-rtk__facts { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0 24px; }
  .set-rtk__spark { width: 100%; }
  .set-diag__grid { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 14px 32px; }
  .set-diag__col:nth-child(3) { grid-column: 1 / -1; }
}
@media (max-width: 959px) {
  .set-rtk__facts { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 16px; }
  .set-rtk__trend { min-width: 0; }
  .set-diag__grid { grid-template-columns: minmax(0, 1fr); gap: 14px; }
  html:root .set-diag .tx-collapse-item__header { min-height: 44px; }
}
@media (max-width: 599px) {
  .set-rtk-auto { flex-wrap: wrap; }
  .set-rtk-auto__line { flex-basis: 100%; font-size: var(--fs-xs); }
  .set-diag__agents { grid-template-columns: minmax(0, 1fr); }
  .set-diag__hint { display: none; }
}
</style>
