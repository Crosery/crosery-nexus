<script setup lang="ts">
/**
 * A/B 实验台（`/ab`）—— 自助、不打断的真实用户参与通道。
 *
 * 设计约束（来自 task-5）：
 * 1. **自身可读**：不发投票也能完整展示 A/B 对照；说明与任务脚本写在页面里，不需要任何人讲解。
 * 2. **不打断用户**：不弹窗、不追问、不阻塞；用户随时来、随时走，投票是可选的最后一步。
 * 3. **深链**：`?flow=<id>&v=a|b|split`，刷新保持、可分享（Lead 负责挂 `/ab` 路由）。
 * 4. **失败要留痕**：提交失败给持久错误 + 重试，不用一闪而过的 toast（红队 D2 的教训）。
 */
import PageHeader from '../components/PageHeader.vue'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { TxCard } from '@talex-touch/tuffex/card'
import { TxButton } from '@talex-touch/tuffex/button'
import { TxTag } from '@talex-touch/tuffex/tag'
import { TxTextarea } from '@talex-touch/tuffex/textarea'
import { TxInput } from '@talex-touch/tuffex/input'
import { AB_FLOWS, AB_METRICS, findFlow, flowPair } from '../ab/flows'
import { AB_CHOICE_LABEL, AB_CHOICES, AB_NOTE_MAX, submitPreference, validatePreference, type AbChoice, type AbFlowId } from '../ab/preference'
import { AB_VIEWS, AB_VIEW_LABEL, labLink, parseLabQuery, type AbView } from '../ab/labState'
import { installReadOnlyGate } from '../ab/readOnlyGate'
import { api } from '../api'

const route = useRoute()
const router = useRouter()

/**
 * 只读闸门（红队第二轮 R1）。
 *
 * A 侧是 `281c30e` 的冻结页面副本，但它们 import 的是**活的 api 模块**，不是沙箱：
 * 红队实测在 `/ab?flow=keys-access&v=a` 点「重置今日用量」**没有确认框**，直接发出
 * `POST /api/keys/<id>/quota/reset` —— 本轮刚验收为「已修」的零确认重置，被自己的实验台绕过了。
 *
 * 对照页面本来就不该产生写副作用（要写就去真实页面写）。闸门分三层（api 函数层 / fetch / XHR），
 * **唯一放行**的是本页自己的投票 `POST /api/ab/preference`：v1 的 fetch 拦截把投票也一起拦了，
 * 等于亲手废掉「真实用户参与」通道，这里按「同源 + 精确路径 + POST」开例外。实现见 `src/ab/readOnlyGate.ts`。
 * 每次拦截都显示出来，避免「点了没反应」被误读成页面坏了。
 */
const blockedWrites = ref(0)
const lastBlocked = ref('')
let releaseGate: (() => void) | null = null

onMounted(() => {
  releaseGate = installReadOnlyGate({
    api: api as unknown as Record<string, unknown>,
    onBlocked: (info) => {
      blockedWrites.value += 1
      lastBlocked.value = info.layer === 'api' ? `api.${info.detail}()` : info.detail
    },
  })
})

onBeforeUnmount(() => {
  releaseGate?.()
  releaseGate = null
})

const state = computed(() => parseLabQuery(route.query as Record<string, unknown>))
const flow = computed(() => findFlow(state.value.flow))
const view = computed(() => state.value.view)
const pair = computed(() => flowPair(flow.value))
const showIntro = computed(() => !state.value.full)

const isSplit = computed(() => view.value === 'split')
const showA = computed(() => view.value === 'a' || isSplit.value)
const showB = computed(() => view.value === 'b' || isSplit.value)

function go(next: { flow?: AbFlowId; view?: AbView }) {
  const target = labLink(next.flow ?? state.value.flow, next.view ?? state.value.view)
  if (route.fullPath !== target) void router.replace(target)
}

function toggleIntro() {
  const target = labLink(state.value.flow, state.value.view, { full: showIntro.value })
  if (route.fullPath !== target) void router.replace(target)
}

/* ── 深链复制（失败给可见反馈，不用 tooltip） ───────────────────────────── */
const copyState = ref('')
let copyTimer: number | undefined

async function copyLink(link: string) {
  const absolute = `${window.location.origin}${link}`
  try {
    await navigator.clipboard.writeText(absolute)
    copyState.value = `已复制：${absolute}`
  } catch {
    copyState.value = `复制失败（浏览器未授权剪贴板），请手动复制：${absolute}`
  }
  window.clearTimeout(copyTimer)
  copyTimer = window.setTimeout(() => { copyState.value = '' }, 6000)
}

/* ── 投票 ──────────────────────────────────────────────────────────────── */
const STORAGE_KEY = 'crosery.ab.votes.v1'
interface LocalVote { choice: AbChoice; note: string; at: string }
const localVotes = ref<Record<string, LocalVote>>(loadLocalVotes())

function loadLocalVotes(): Record<string, LocalVote> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, LocalVote>) : {}
  } catch {
    return {}
  }
}

const choice = ref<AbChoice | null>(null)
const note = ref('')
const blocker = ref('')
const submitting = ref(false)
const status = ref<{ kind: 'ok' | 'error'; text: string; detail?: string } | null>(null)
const lastVote = computed(() => localVotes.value[state.value.flow])

// 换流程时重置草稿，避免把上一条流程的理由投给下一条。
watch(() => state.value.flow, () => {
  choice.value = null
  note.value = ''
  blocker.value = ''
  status.value = null
})

async function submit() {
  if (!choice.value) {
    status.value = { kind: 'error', text: '先选一个：选 A / 选 B / 都不行。' }
    return
  }
  const input = {
    flow: state.value.flow,
    choice: choice.value,
    note: note.value,
    blocker: blocker.value,
  }
  const local = validatePreference(input)
  if (!local.ok) {
    status.value = { kind: 'error', text: local.error }
    return
  }
  submitting.value = true
  status.value = null
  try {
    const result = await submitPreference(local.value)
    const at = new Date().toISOString()
    const votes: Record<string, LocalVote> = { ...localVotes.value, [local.value.flow]: { choice: local.value.choice, note: local.value.note, at } }
    localVotes.value = votes
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(votes)) } catch { /* 本机记录失败不影响服务端留痕 */ }
    status.value = { kind: 'ok', text: `已记录（${result.id}）：这一票会出现在 data/ab-preferences.jsonl 里。` }
    note.value = ''
    blocker.value = ''
  } catch (error) {
    status.value = {
      kind: 'error',
      text: `提交失败：${error instanceof Error ? error.message : '未知错误'}`,
      detail: '这条理由没有被记录。可以直接重试；如果一直失败，把这条错误原文发给维护者。',
    }
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="ab-lab">
    <PageHeader
      title="A / B 交互对照台"
      description="自助，不打断：随时自己打开比较、投一票就走，不需要任何人讲解。"
      :crumbs="[{ label: '首页', to: '/dashboard' }, { label: 'A/B 实验台' }]"
    >
      <template #meta>
        <p class="ab-lab__lede">
          同一个真实流程的新旧两版放在这里。A = 迁移前（提交 <code>281c30e</code> 的冻结副本），B = 迁移后（当前线上页面）。
          你可以随时自己打开比较，投一票就走；不需要任何人讲解，也不会有人来问你。
        </p>
      </template>
      <template #actions>
        <TxButton variant="secondary" size="sm" icon="i-carbon-copy" @click="copyLink(labLink(state.flow, state.view))">复制当前深链</TxButton>
        <TxButton variant="ghost" size="sm" @click="toggleIntro">{{ showIntro ? '只看对照' : '显示使用说明' }}</TxButton>
      </template>
      <p v-if="copyState" class="ab-lab__copy" role="status">{{ copyState }}</p>
    </PageHeader>

    <section v-if="showIntro" class="ab-lab__panel" aria-label="怎么用">
      <h2>怎么用（约 2 分钟）</h2>
      <ol class="ab-lab__steps">
        <li><strong>选流程</strong>：下面三个都是真实业务流程，读的是真实数据（14 个 Key、真实渠道与用量）。</li>
        <li><strong>按任务脚本做一遍</strong>：先在 A 侧做，切到 B 侧再做一次；脚本和合格线就在本页，不用另开文档。</li>
        <li><strong>投一票</strong>：页面底部选「选 A / 选 B / 都不行」，写一句话理由即可。<em>不投也没关系</em>，对照本身就能看。</li>
      </ol>
      <ul class="ab-lab__safety">
        <li>本页只做只读浏览；不会替你点删除、重置、剪枝等破坏性动作（走到确认框就停手）。</li>
        <li>投票写入 <code>data/ab-preferences.jsonl</code>：只记流程、选择、一句话理由、时间、浏览器 UA。</li>
        <li><strong>不会记录 API Key / 密码 / Prompt 内容</strong>；粘贴到理由里的疑似密钥会被服务端替换成「[已隐去疑似密钥]」。</li>
        <li>汇总查看：<code>node scripts/ab-report.mjs</code>（按流程统计 A/B 票数与理由摘要）。</li>
      </ul>
    </section>

    <nav class="ab-lab__switcher" aria-label="选择实验流程">
      <button
        v-for="item in AB_FLOWS"
        :key="item.id"
        type="button"
        class="ab-lab__switch"
        :class="{ 'is-active': item.id === state.flow }"
        :aria-pressed="item.id === state.flow"
        @click="go({ flow: item.id })"
      >
        <span class="ab-lab__switch-title">{{ item.title }}</span>
        <span class="ab-lab__switch-sub">{{ item.subtitle }}</span>
      </button>
    </nav>

    <section class="ab-lab__task" aria-label="任务脚本与判定标准">
      <article class="ab-lab__task-card">
        <h2>{{ flow.task.title }}</h2>
        <ol class="ab-lab__task-steps">
          <li v-for="step in flow.task.steps" :key="step.id">{{ step.text }}</li>
        </ol>
        <p v-if="flow.docHint" class="ab-lab__hint">文档面：{{ flow.docHint }}</p>
      </article>
      <article class="ab-lab__task-card">
        <h2>「好」的判定标准（六项固定口径：{{ AB_METRICS.join(' / ') }}）</h2>
        <div class="ab-lab__criteria-scroll">
          <table class="ab-lab__criteria">
            <thead>
              <tr><th scope="col">维度</th><th scope="col">合格线（看到什么算通过）</th><th scope="col">审计出处</th></tr>
            </thead>
            <tbody>
              <tr v-for="c in flow.criteria" :key="c.id">
                <td>{{ c.metric }}</td>
                <td>{{ c.pass }}</td>
                <td><code>{{ c.ref }}</code></td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="ab-lab__gap">迁移前已知差距（来自红队审计，用来解释差值，不作为结论）：{{ flow.gap }}</p>
      </article>
    </section>

    <nav class="ab-lab__viewbar" aria-label="选择对照视图">
      <span class="ab-lab__viewbar-label">视图</span>
      <button
        v-for="item in AB_VIEWS"
        :key="item"
        type="button"
        class="ab-lab__view"
        :class="{ 'is-active': item === state.view }"
        :aria-pressed="item === state.view"
        @click="go({ view: item })"
      >
        {{ AB_VIEW_LABEL[item] }}
      </button>
      <span class="ab-lab__viewbar-hint">深链：<code>{{ labLink(state.flow, state.view) }}</code></span>
    </nav>

    <div class="ab-lab__readonly" role="note">
      <i class="i-carbon-locked" aria-hidden="true" />
      <span>
        本页是<strong>只读对照</strong>：A/B 两侧的写操作（删除、重置、剪枝、开关）都会被拦截，不会改到真实数据；要真的执行请到对应真实页面。
      </span>
      <span v-if="blockedWrites > 0" class="ab-lab__readonly-hit" role="status">
        已拦截 {{ blockedWrites }} 次写请求<template v-if="lastBlocked">（最近：{{ lastBlocked }}）</template>
      </span>
    </div>

    <div class="ab-lab__stage" :class="isSplit ? 'ab-lab__stage--split' : 'ab-lab__stage--single'">
      <section v-if="showA" class="lab-frame" aria-label="A 版本：迁移前">
        <header class="lab-frame__bar">
          <TxTag size="sm" variant="soft" color="var(--tx-color-text-secondary)" label="A" />
          <span class="lab-frame__title">{{ flow.labels.a }}</span>
          <a class="lab-frame__open" :href="labLink(state.flow, 'a', { full: true })" target="_blank" rel="noopener">单侧打开</a>
        </header>
        <div class="lab-frame__body">
          <component :is="pair.legacy" />
        </div>
        <details v-if="pair.legacyDoc" class="lab-frame__doc">
          <summary>需要看文档时展开：A 侧文档面（迁移前帮助页冻结副本）</summary>
          <div class="lab-frame__body lab-frame__body--doc">
            <component :is="pair.legacyDoc" />
          </div>
        </details>
      </section>

      <section v-if="showB" class="lab-frame" aria-label="B 版本：迁移后">
        <header class="lab-frame__bar">
          <TxTag size="sm" variant="soft" color="var(--tx-color-primary)" label="B" />
          <span class="lab-frame__title">{{ flow.labels.b }}</span>
          <a class="lab-frame__open" :href="labLink(state.flow, 'b', { full: true })" target="_blank" rel="noopener">单侧打开</a>
        </header>
        <div class="lab-frame__body">
          <component :is="pair.current" />
        </div>
        <details v-if="pair.currentExtra" class="lab-frame__doc">
          <summary>{{ pair.currentExtraLabel || 'B 侧新增面' }}</summary>
          <div class="lab-frame__body lab-frame__body--doc">
            <component :is="pair.currentExtra" />
          </div>
        </details>
        <details v-if="pair.currentDoc" class="lab-frame__doc">
          <summary>需要看文档时展开：B 侧文档面（当前帮助页）</summary>
          <div class="lab-frame__body lab-frame__body--doc">
            <component :is="pair.currentDoc" />
          </div>
        </details>
      </section>
    </div>

    <TxCard class="ab-lab__vote">
      <h2>投一票：这个流程哪一版更顺手？</h2>
      <p class="ab-lab__vote-lede">
        一句话理由就够。选「都不行」时请写清哪里不行，这样才改得动。
        <span v-if="lastVote" class="ab-lab__vote-last">
          本机记录：{{ lastVote.choice === 'a' ? 'A' : lastVote.choice === 'b' ? 'B' : '都不行' }}{{ lastVote.note ? `（${lastVote.note}）` : '' }}
        </span>
      </p>
      <div class="ab-lab__choices">
        <button
          v-for="item in AB_CHOICES"
          :key="item"
          type="button"
          class="ab-lab__choice"
          :class="{ 'is-active': choice === item }"
          :aria-pressed="choice === item"
          @click="choice = item"
        >
          {{ AB_CHOICE_LABEL[item] }}
        </button>
      </div>
      <label class="ab-lab__field">
        <span>一句话理由（不会记录 API Key / 密码 / Prompt）</span>
        <TxTextarea v-model="note" :rows="2" :maxlength="AB_NOTE_MAX" placeholder="例如：B 的搜索进 URL，刷新不丢；A 的删除确认叠在编辑弹窗上，我差点点错。" />
      </label>
      <label class="ab-lab__field">
        <span>（可选）卡在哪一步</span>
        <TxInput v-model="blocker" placeholder="例如：第 3 步刷新后筛选丢了，只能重选一次" />
      </label>
      <div class="ab-lab__vote-actions">
        <TxButton variant="primary" :loading="submitting" :disabled="submitting" @click="submit">提交这一票</TxButton>
        <span class="ab-lab__vote-count">{{ note.length }} / {{ AB_NOTE_MAX }} 字</span>
      </div>
      <p v-if="status" class="ab-lab__status" :class="`ab-lab__status--${status.kind}`" role="status">
        {{ status.text }}
        <span v-if="status.detail" class="ab-lab__status-detail">{{ status.detail }}</span>
        <TxButton v-if="status.kind === 'error'" variant="ghost" size="sm" @click="submit">重试</TxButton>
      </p>
    </TxCard>
  </div>
</template>

<style scoped>
.ab-lab { display: flex; flex-direction: column; gap: 18px; padding-bottom: 48px; }
/* 页头统一走共享 PageHeader（TUF 标准 h1 = 22px/600/30px）。
   原来这里的 .ab-lab__hero h1（26px/1.25）、.ab-lab__eyebrow 全部是手写页头的一部分，已删除。
   .ab-lab__lede 现在放在 PageHeader 的 meta 槽里，继承全局 .page-head p（14px/22px）。 */
.ab-lab__lede { margin: 4px 0 0; max-width: 72ch; color: var(--tx-text-color-secondary); }
.ab-lab__copy { margin: 4px 0 0; font-size: 13px; color: var(--tx-color-text-secondary, #4b5563); word-break: break-all; }

.ab-lab__panel { border: 1px solid var(--tx-color-border, #e5e7eb); border-radius: 10px; padding: 14px 18px; background: var(--tx-color-surface, #fff); }
.ab-lab__panel h2 { margin: 0 0 8px; font-size: 15px; font-weight: 600; line-height: 22px; }
.ab-lab__steps { margin: 0 0 10px; padding-left: 20px; line-height: 1.8; }
.ab-lab__safety { margin: 0; padding-left: 20px; line-height: 1.8; color: var(--tx-color-text-secondary, #4b5563); font-size: 13px; }
.ab-lab code { padding: 1px 5px; border-radius: 4px; background: var(--tx-color-fill, #f3f4f6); font-size: 12px; }

.ab-lab__switcher { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 10px; }
.ab-lab__switch { display: flex; flex-direction: column; gap: 4px; text-align: left; padding: 12px 14px; border: 1px solid var(--tx-color-border, #e5e7eb); border-radius: 10px; background: var(--tx-color-surface, #fff); cursor: pointer; font: inherit; }
.ab-lab__switch:hover { border-color: var(--tx-color-primary, #3346c8); }
.ab-lab__switch.is-active { border-color: var(--tx-color-primary, #3346c8); box-shadow: inset 3px 0 0 var(--tx-color-primary, #3346c8); }
.ab-lab__switch-title { font-weight: 600; }
.ab-lab__switch-sub { font-size: 12px; color: var(--tx-color-text-secondary, #4b5563); line-height: 1.6; }

.ab-lab__task { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 12px; }
.ab-lab__task-card { border: 1px solid var(--tx-color-border, #e5e7eb); border-radius: 10px; padding: 14px 18px; background: var(--tx-color-surface, #fff); }
.ab-lab__task-card h2 { margin: 0 0 8px; font-size: 15px; font-weight: 600; line-height: 22px; }
.ab-lab__task-steps { margin: 0; padding-left: 20px; line-height: 1.8; }
.ab-lab__hint, .ab-lab__gap { margin: 10px 0 0; font-size: 12px; color: var(--tx-color-text-secondary, #4b5563); line-height: 1.7; }
.ab-lab__criteria-scroll { overflow-x: auto; }
.ab-lab__criteria { width: 100%; border-collapse: collapse; font-size: 13px; }
.ab-lab__criteria th, .ab-lab__criteria td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--tx-color-border, #eef0f4); vertical-align: top; line-height: 1.6; }
.ab-lab__criteria th { font-weight: 600; white-space: nowrap; }
.ab-lab__criteria td:first-child { white-space: nowrap; }

.ab-lab__viewbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ab-lab__viewbar-label { font-size: 13px; color: var(--tx-color-text-secondary, #4b5563); }
.ab-lab__view { padding: 6px 12px; border: 1px solid var(--tx-color-border, #e5e7eb); border-radius: 999px; background: var(--tx-color-surface, #fff); cursor: pointer; font: inherit; font-size: 13px; }
.ab-lab__view.is-active { border-color: var(--tx-color-primary, #3346c8); color: var(--tx-color-primary, #3346c8); font-weight: 600; }
.ab-lab__viewbar-hint { margin-left: auto; font-size: 12px; color: var(--tx-color-text-secondary, #4b5563); }

.ab-lab__readonly {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 12px 0 0;
  padding: 8px 12px;
  border: 1px solid var(--tx-color-warning, #d97706);
  border-radius: 8px;
  background: color-mix(in srgb, var(--tx-color-warning, #d97706) 8%, transparent);
  font-size: 12px;
  line-height: 18px;
  color: var(--tx-color-text-secondary, #4b5563);
}
.ab-lab__readonly-hit {
  margin-left: auto;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--tx-color-warning, #d97706);
  color: #fff;
  white-space: nowrap;
}
.ab-lab__stage { display: grid; gap: 14px; align-items: start; }
.ab-lab__stage--split { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.ab-lab__stage--single { grid-template-columns: minmax(0, 1fr); }
@media (max-width: 1100px) { .ab-lab__stage--split { grid-template-columns: minmax(0, 1fr); } }

.lab-frame { border: 1px solid var(--tx-color-border, #e5e7eb); border-radius: 10px; background: var(--tx-color-surface, #fff); overflow: hidden; }
.lab-frame__bar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--tx-color-border, #eef0f4); background: var(--tx-color-fill, #f8fafc); }
.lab-frame__title { font-size: 13px; font-weight: 600; }
.lab-frame__open { margin-left: auto; font-size: 12px; color: var(--tx-color-primary, #3346c8); }
.lab-frame__body { max-height: min(70vh, 860px); overflow: auto; }
.lab-frame__body--doc { max-height: 40vh; }
.lab-frame__doc { border-top: 1px solid var(--tx-color-border, #eef0f4); }
.lab-frame__doc summary { padding: 8px 12px; cursor: pointer; font-size: 12px; color: var(--tx-color-text-secondary, #4b5563); }
:deep(.lab-frame__state) { margin: 0; padding: 16px 18px; font-size: 13px; color: var(--tx-color-text-secondary, #4b5563); }
:deep(.lab-frame__state--error) { color: var(--tx-color-danger, #b91c1c); }

.ab-lab__vote { display: flex; flex-direction: column; gap: 10px; }
.ab-lab__vote h2 { margin: 0; font-size: 15px; font-weight: 600; line-height: 22px; }
.ab-lab__vote-lede { margin: 0; font-size: 13px; color: var(--tx-color-text-secondary, #4b5563); line-height: 1.7; }
.ab-lab__vote-last { display: inline-block; margin-left: 6px; }
.ab-lab__choices { display: flex; gap: 8px; flex-wrap: wrap; }
.ab-lab__choice { padding: 8px 14px; border: 1px solid var(--tx-color-border, #e5e7eb); border-radius: 8px; background: var(--tx-color-surface, #fff); cursor: pointer; font: inherit; font-size: 14px; }
.ab-lab__choice.is-active { border-color: var(--tx-color-primary, #3346c8); color: var(--tx-color-primary, #3346c8); font-weight: 600; }
.ab-lab__field { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: var(--tx-color-text-secondary, #4b5563); }
.ab-lab__vote-actions { display: flex; align-items: center; gap: 12px; }
.ab-lab__vote-count { font-size: 12px; color: var(--tx-text-color-secondary, #535b85); }
.ab-lab__status { margin: 0; padding: 10px 12px; border-radius: 8px; font-size: 13px; line-height: 1.7; }
.ab-lab__status--ok { background: var(--tx-color-success-fill, #ecfdf5); color: var(--tx-color-success, #047857); }
.ab-lab__status--error { background: var(--tx-color-danger-fill, #fef2f2); color: var(--tx-color-danger, #b91c1c); }
.ab-lab__status-detail { display: block; margin-top: 4px; }
</style>
