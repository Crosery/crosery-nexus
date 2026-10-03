<script setup lang="ts">
/**
 * 网关内核（中转站）：CPA 接流量、Magpie 备用，各自的版本、上游、候选、自动更新开关、上次结果和一键回滚。
 *
 * 读 `/api/kernels`（server/kernels.ts，只读中转站定时任务记下的状态）；开关和时段写 `PUT /api/kernels`，回滚只是排队
 * （`POST /api/kernels/rollback`，确认后才发），真正的替换和回滚都由 crosery-kernel-update 定时任务经安装脚本完成。
 */
import { computed, ref } from 'vue'
import { TxButton } from '@talex-touch/tuffex/button'
import StatusMark from '../../ui/data/StatusMark.vue'
import Sheet from '../../ui/feedback/Sheet.vue'
import Switch from '../../ui/form/Switch.vue'
import { confirmSheet } from '../../ui/feedback/confirmSheet'
import { notify } from '../../ui/feedback/toast'
import { useLive } from '../../ui/composables/useLive'
import { api } from '../../api'
import { errorMessage } from '../../lib/errors'
import { fmtTime } from '../../ui/fmt'
import type { KernelView, KernelsView } from '../../types'

const live = useLive<KernelsView>(() => api.kernels.get(), { intervalMs: 60_000 })
const data = computed(() => live.data.value ?? null)
const busy = ref<string | null>(null)
const reasonsOf = ref<KernelView | null>(null)
const windowOpen = ref(false)
const draft = ref({ start: '', end: '' })

/** 「北京时间」：时段说明里的时区词（label 括号里那段） */
const zoneWord = computed(() => /（(.+)）$/.exec(data.value?.window.label ?? '')?.[1] ?? '')

const mark = (tone: string) => (tone === 'bad' ? '◆ ' : tone === 'warn' ? '◇ ' : '')

async function toggle(kernel: KernelView, on: boolean) {
  busy.value = `switch-${kernel.id}`
  try {
    live.data.value = await api.kernels.set({ [kernel.id]: { enabled: on } })
  } catch (error) {
    notify(`◆ 没保存 · ${errorMessage(error) || '请求失败'}`, { tone: 'bad', id: 'cx-kernels' })
  } finally {
    busy.value = null
  }
}

async function rollback(kernel: KernelView) {
  if (!kernel.rollback) return
  const ok = await confirmSheet({
    title: `回滚 ${kernel.name}？`,
    facts: [
      { k: '当前', v: kernel.version ?? '未知' },
      { k: '回到', v: kernel.rollback.to },
      { k: '方式', v: kernel.role === 'serving' ? '经安装脚本：先过兼容检查，失败再换回来' : '切回上一个备用内核，不影响流量' },
    ],
    consequence: kernel.role === 'serving' ? 'CPA 会重启 · 正在进行的请求可能中断 · 这个版本之后不再自动换上' : '这个版本之后不再自动换上',
    confirmText: '回滚',
    danger: kernel.role === 'serving',
  })
  if (!ok) return
  busy.value = `rollback-${kernel.id}`
  try {
    const queued = await api.kernels.rollback(kernel.id)
    notify(`✓ 已提交回滚到 ${queued.to} · 定时任务几秒内执行，结果看「上次」`, { tone: 'ok', id: 'cx-kernels' })
  } catch (error) {
    notify(`◆ 没提交 · ${errorMessage(error) || '请求失败'}`, { tone: 'bad', id: 'cx-kernels' })
  } finally {
    busy.value = null
    setTimeout(() => void live.refresh(), 8_000)
  }
}

function editWindow() {
  if (!data.value) return
  draft.value = { start: data.value.window.start, end: data.value.window.end }
  windowOpen.value = true
}

async function saveWindow() {
  busy.value = 'window'
  try {
    live.data.value = await api.kernels.set({ window: { ...draft.value } })
    windowOpen.value = false
  } catch (error) {
    notify(`◆ 没保存 · ${errorMessage(error) || '请求失败'}`, { tone: 'bad', id: 'cx-kernels' })
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <div v-if="data?.available" class="set-krn">
    <section v-for="k in data.kernels" :key="k.id" class="set-krn__k">
      <header class="set-krn__h">
        <b class="set-krn__name">{{ k.name }}</b>
        <span class="set-krn__role" :class="`is-${k.role}`">{{ k.roleText }}</span>
        <span class="num set-krn__ver">{{ k.version ?? '—' }}</span>
        <StatusMark v-if="k.role === 'serving'" :state="k.online ? 'run' : 'bad'" :label="k.online ? '运行中' : '离线'" />
      </header>
      <dl class="set-krn__facts">
        <dt>上游</dt>
        <dd>
          <template v-if="k.upstream">
            <span class="num">{{ k.upstream.latest ?? '—' }}</span>
            <span v-if="k.upstream.line" class="dim">跟随 {{ k.upstream.line }}.x</span>
            <span v-if="k.upstream.heldNewer" class="set-krn__warn">◇ {{ k.upstream.heldNewer }} 要人工合并补丁</span>
            <span v-if="k.upstream.checkedAt" class="dim">检查于 {{ fmtTime(k.upstream.checkedAt) }}</span>
          </template>
          <span v-else class="dim">— 构建机还没报告</span>
        </dd>
        <dt>候选</dt>
        <dd>
          <template v-if="k.candidate">
            <span class="num">{{ k.candidate.label }}</span>
            <span class="set-krn__t" :class="`is-${k.candidate.tone}`">{{ mark(k.candidate.tone) }}{{ k.candidate.text }}</span>
          </template>
          <span v-else class="dim">—</span>
        </dd>
        <dt>自动更新</dt>
        <dd class="set-krn__auto">
          <Switch
            :model-value="k.enabled"
            :loading="busy === `switch-${k.id}`"
            :disabled="busy !== null"
            :aria-label="`${k.name} 自动更新 · ${k.enabled ? '开' : '关'}`"
            @update:model-value="toggle(k, $event)"
          />
          <span class="set-krn__t" :class="`is-${k.tone}`">{{ mark(k.tone) }}{{ k.line }}</span>
          <button v-if="k.reasons.length > 1" type="button" class="ui-link set-krn__why" @click="reasonsOf = k">全部原因 →</button>
        </dd>
        <dt>上次</dt>
        <dd>
          <span v-if="k.last" class="set-krn__t" :class="`is-${k.last.tone}`">{{ mark(k.last.tone) }}{{ k.last.text }}</span>
          <span v-else class="dim">— 还没替换过</span>
          <TxButton
            v-if="k.rollback"
            size="sm"
            variant="secondary"
            :loading="busy === `rollback-${k.id}`"
            :disabled="busy !== null"
            @click="rollback(k)"
          >
            回滚到 {{ k.rollback.to }}…
          </TxButton>
        </dd>
      </dl>
    </section>
    <p class="set-krn__win">
      <span>替换时段 <b class="num">{{ data.window.label }}</b> · 每个版本只试一次 · 失败自动回滚</span>
      <button type="button" class="ui-link" @click="editWindow">改时段</button>
      <span v-if="data.scheduler === 'missing'" class="set-krn__warn">◇ 中转站还没装内核更新定时任务</span>
      <span v-else-if="data.scheduler === 'stale'" class="set-krn__warn">◇ 定时任务超过 30 分钟没跑</span>
    </p>
  </div>
  <!-- not the relay (the Mac's Magpie, or an older server): whatever the caller showed before -->
  <slot v-else-if="data || live.error.value" name="fallback" />

  <Sheet v-if="reasonsOf" :model-value="Boolean(reasonsOf)" :title="`为什么没替换 · ${reasonsOf.name}`" @update:model-value="reasonsOf = null">
    <ul class="set-why">
      <li v-for="r in reasonsOf.reasons" :key="r.code + r.text">{{ r.text }}</li>
    </ul>
  </Sheet>

  <Sheet v-model="windowOpen" title="替换时段">
    <form class="set-krn__form" @submit.prevent="saveWindow">
      <label>开始 <input v-model="draft.start" type="time" required></label>
      <label>结束 <input v-model="draft.end" type="time" required></label>
      <p class="set-diff__note">按{{ zoneWord }}算 · 只在这段时间替换接流量的 CPA · 备用的 Magpie 随时换</p>
      <TxButton type="submit" size="sm" :loading="busy === 'window'" :disabled="busy !== null || draft.start === draft.end">保存</TxButton>
    </form>
  </Sheet>
</template>

<style>
.set-krn { display: grid; gap: 14px; min-width: 0; padding: 4px 0 2px; }
.set-krn__k { display: grid; gap: 4px; min-width: 0; }
.set-krn__h { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; }
.set-krn__name { font-size: var(--fs-base); font-weight: 600; }
.set-krn__role { font-size: var(--fs-xs); color: var(--ink-3); }
.set-krn__role.is-serving { color: var(--ink); }
.set-krn__ver { font-size: var(--fs-sm); color: var(--ink); overflow-wrap: anywhere; }
.set-krn__facts { display: grid; grid-template-columns: 72px minmax(0, 1fr); gap: 0 20px; margin: 0; font-size: var(--fs-sm); }
.set-krn__facts dt, .set-krn__facts dd { margin: 0; min-height: 28px; display: flex; align-items: center; min-width: 0; }
.set-krn__facts dt { color: var(--ink-3); white-space: nowrap; }
.set-krn__facts dd { flex-wrap: wrap; gap: 2px 12px; color: var(--ink); }
.set-krn__facts dd .dim { font-size: var(--fs-xs); }
.set-krn__facts dd.set-krn__auto { flex-wrap: nowrap; align-items: flex-start; gap: 10px; padding: 5px 0; }
.set-krn__auto .ui-switch { flex: none; margin-top: 1px; }
.set-krn__t { min-width: 0; line-height: 1.5; color: var(--ink-2); overflow-wrap: anywhere; }
.set-krn__t.is-bad { color: var(--signal-ink); }
.set-krn__why { flex: none; font-size: var(--fs-xs); line-height: 1.5; }
.set-krn__warn { font-size: var(--fs-xs); color: var(--ink-2); }
.set-krn__win { margin: 0; padding-top: 10px; border-top: 1px solid var(--rule); display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: var(--fs-xs); color: var(--ink-3); }
.set-krn__win b { color: var(--ink); font-weight: 600; }
.set-krn__form { display: grid; gap: 12px; justify-items: start; }
.set-krn__form label { display: flex; gap: 10px; align-items: center; font-size: var(--fs-sm); color: var(--ink-2); }
.set-krn__form input { font: inherit; font-family: var(--font-mono); padding: 4px 8px; border: 1px solid var(--rule); border-radius: 6px; background: transparent; color: var(--ink); }

@media (max-width: 599px) {
  .set-krn__facts { grid-template-columns: minmax(0, 1fr); }
  .set-krn__facts dt { min-height: 0; padding-top: 8px; font-size: var(--fs-xs); }
}
</style>
