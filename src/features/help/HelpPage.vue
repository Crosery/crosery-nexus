<script setup lang="ts">
import { computed, h, onBeforeUnmount, onMounted, ref, type FunctionalComponent } from 'vue'
import { useRouter } from 'vue-router'
import { TxButton } from '@talex-touch/tuffex/button'
import { TxTag } from '@talex-touch/tuffex/tag'
import { TxCollapse, TxCollapseItem } from '@talex-touch/tuffex/collapse'
import PageHead from '../../ui/shell/PageHead.vue'
import Plate from '../../ui/data/Plate.vue'
import StateBlock from '../../ui/data/StateBlock.vue'
import CopyField from '../../ui/form/CopyField.vue'
import CodeSnippet from '../../ui/form/CodeSnippet.vue'
import ShareBar from '../../ui/viz/ShareBar.vue'
import Sheet from '../../ui/feedback/Sheet.vue'
import Icon from '../../ui/Icon.vue'
import { copyText } from '../../ui/feedback/toast'
import { resolveDataState, type DataState } from '../../ui/composables/useLive'
import { isReducedMotion } from '../../ui/composables/prefs'
import { fmtInt } from '../../ui/fmt'
import { useResource } from '../../lib/resource'
import { usePaletteCommands } from '../../shell/palette'
import { api } from '../../api'
import { request } from '../../api/http'
import type { ModelIndexData } from '../../types'
import {
  AUTH_HEADER,
  CRAPI_INSTALL,
  DEFAULT_BASE,
  DEFAULT_EXAMPLES,
  EXPORT_COPY,
  EXPORT_SHOWN,
  KEY_ENV,
  anthropicBaseOf,
  clientSnippets,
  crapiCommands,
  faqItems,
  inlineParts,
  modelsCheck,
  pickExamples,
  vendorShares,
} from './helpContent'

/**
 * /help (DESIGN §6.9). First viewport = Base URL + auth (CopyField), then per-client snippets, the
 * `GET /v1/models` check against the gateway's in-use catalog, crapi, and a collapsed FAQ.
 * Snippets only ever reference `$CROSERY_API_KEY`; this page never reads a key.
 * Base URL comes from `GET /api/connect` (same source as the key user's /me/connect). Until the server
 * has that route (404) or when it fails, the documented production base is shown and labelled as such.
 */
type ConnectInfo = { baseUrl: string; anthropicBaseUrl: string | null; configured: boolean }

const router = useRouter()

const connect = useResource(() => request<ConnectInfo>('/api/connect'))
const catalog = useResource(() => api.modelIndex<ModelIndexData>())

const settled = (r: { data: { value: unknown }; error: { value: unknown }; loading: { value: boolean } }) =>
  r.data.value !== undefined || (r.error.value != null && !r.loading.value)

/** only a well-formed answer counts; anything else falls back to the labelled default */
const info = computed(() => (typeof connect.data.value?.baseUrl === 'string' && connect.data.value.baseUrl ? connect.data.value : null))
const base = computed(() => info.value?.baseUrl ?? DEFAULT_BASE)
const anthropicBase = computed(() => (info.value ? info.value.anthropicBaseUrl : anthropicBaseOf(DEFAULT_BASE)))
const baseHint = computed(() => {
  if (!settled(connect)) return undefined
  if (!info.value) return '默认公网地址 · 没读到网关配置'
  if (!info.value.configured) return '本机网关 · 未设公网地址 PUBLIC_GATEWAY_BASE_URL · Key 用户看到的也是它'
  return 'Key 用户的接入页显示同一个地址'
})
const startState = computed<DataState>(() => (settled(connect) ? 'ready' : 'loading'))

/** = /channels「可路由」(enabled sources, by id); /models「在用」groups aliases, so it reads lower */
const inUse = computed(() => {
  const models = catalog.data.value?.models
  return Array.isArray(models) ? models.filter((m) => m.enabledSources > 0 && typeof m.id === 'string').map((m) => m.id) : []
})
const examples = computed(() => (catalog.data.value ? pickExamples(inUse.value) : DEFAULT_EXAMPLES))
const modelsState = computed<DataState>(() =>
  resolveDataState({
    hasData: catalog.data.value !== undefined,
    loading: catalog.loading.value,
    error: catalog.error.value,
    empty: inUse.value.length === 0,
    ageMs: null,
    intervalMs: 0,
  }),
)
const shares = computed(() => vendorShares(inUse.value))
const exampleIds = computed(() => [...new Set([examples.value.claude, examples.value.gpt, examples.value.image])])
const inCatalog = computed(() => new Set(inUse.value))

const clients = computed(() => clientSnippets(base.value, anthropicBase.value, examples.value))
const clientsState = computed<DataState>(() => (settled(connect) && settled(catalog) ? 'ready' : 'loading'))
const client = ref('curl')
const currentClient = computed(() => clients.value.find((c) => c.id === client.value) ?? clients.value[0])
const HIGHLIGHT = [`$${KEY_ENV}`, KEY_ENV]

const check = computed(() => [modelsCheck(base.value)])
const crapiOs = ref(CRAPI_INSTALL[0].id)
const crapiCmd = computed(() => [crapiCommands(examples.value)])

const usageUrl = computed(() => `${typeof location === 'undefined' ? '' : location.origin}/v1/usage`)
const faq = computed(() => faqItems(base.value, usageUrl.value))
const open = ref<string[]>([])
const allOpen = computed(() => faq.value.length > 0 && open.value.length === faq.value.length)
function toggleAll() {
  open.value = allOpen.value ? [] : faq.value.map((f) => f.id)
}
/** two independent columns on wide screens, so opening one answer never shifts the other column */
const faqCols = computed(() => {
  const half = Math.ceil(faq.value.length / 2)
  return [faq.value.slice(0, half), faq.value.slice(half)]
})
/** each column is its own TxCollapse; one `open` list keeps 全部展开 true to both. Fresh arrays per column:
 * TxCollapse pushes into the array it was given before it emits. */
const colOpen = computed(() => faqCols.value.map((col) => open.value.filter((id) => col.some((f) => f.id === id))))
function setCol(c: number, names: string | string[]) {
  const mine = new Set(faqCols.value[c].map((f) => f.id))
  const picked = (Array.isArray(names) ? names : [names]).filter((id) => mine.has(id))
  open.value = [...open.value.filter((id) => !mine.has(id)), ...picked]
}

const status = computed(() => {
  const n = inUse.value.length
  return `三种协议 同一把 Key${catalog.data.value && n ? ` · 可路由 ${fmtInt(n)} 个模型` : ''}`
})

/** inline text with `code` spans */
const Inline: FunctionalComponent<{ text: string }> = (props) =>
  inlineParts(props.text).map((part) => (part.code ? h('code', { class: 'help-ic' }, part.t) : part.t))

/* ── table of contents: sticky rail ≥960, `目录` sheet below; scroll-spy marks the section under the header ── */
const sections = [
  { id: 'start', label: '开始之前' },
  { id: 'clients', label: '调用示例' },
  { id: 'models', label: '检查模型' },
  { id: 'crapi', label: 'crapi 一键接入' },
  { id: 'faq', label: '常见问题' },
]
const active = ref('start')
const tocOpen = ref(false)

function headerBottom(): number {
  let bottom = 0
  for (const el of document.querySelectorAll<HTMLElement>('.ui-head, .ui-ticker')) bottom = Math.max(bottom, el.getBoundingClientRect().bottom)
  return bottom
}
let raf = 0
let pinned: string | null = null
function spy() {
  raf = 0
  const line = headerBottom() + 32
  let row: string[] = [sections[0].id]
  let rowTop = -Infinity
  for (const s of sections) {
    const top = document.getElementById(s.id)?.getBoundingClientRect().top
    if (top === undefined || top > line) continue
    // plates side by side share a top: they form one row
    if (top > rowTop + 4) row = [s.id]
    else row.push(s.id)
    rowTop = Math.max(rowTop, top)
  }
  const doc = document.documentElement
  const atBottom = window.scrollY > 0 && window.innerHeight + window.scrollY >= doc.scrollHeight - 4
  // a jump keeps its target marked while it is on screen and in the current row (or the page cannot scroll further)
  if (pinned) {
    const box = document.getElementById(pinned)?.getBoundingClientRect()
    if (box && box.top < window.innerHeight && box.bottom > line && (row.includes(pinned) || atBottom)) {
      active.value = pinned
      return
    }
    pinned = null
  }
  active.value = atBottom ? sections[sections.length - 1].id : row[0]
}
function onScroll() {
  if (!raf) raf = requestAnimationFrame(spy)
}
function jump(id: string) {
  const el = document.getElementById(id)
  if (!el) return
  const top = el.getBoundingClientRect().top + window.scrollY - headerBottom() - 14
  window.scrollTo({ top: Math.max(0, top), behavior: isReducedMotion() ? 'auto' : 'smooth' })
  el.focus({ preventScroll: true })
  pinned = id
  active.value = id
}
let sheetTimer: ReturnType<typeof setTimeout> | null = null
function jumpFromSheet(id: string) {
  tocOpen.value = false
  // let the sheet leave and hand focus back to its trigger before scrolling away from it
  if (sheetTimer) clearTimeout(sheetTimer)
  sheetTimer = setTimeout(() => jump(id), isReducedMotion() ? 140 : 320)
}
onMounted(() => {
  window.addEventListener('scroll', onScroll, { passive: true })
  spy()
})
onBeforeUnmount(() => {
  window.removeEventListener('scroll', onScroll)
  if (raf) cancelAnimationFrame(raf)
  if (sheetTimer) clearTimeout(sheetTimer)
})

usePaletteCommands(() => [
  { id: 'act:help:copy-base', title: '复制 Base URL', section: 'ACT', keywords: ['base', 'url', '地址', '接入'], run: () => void copyText(base.value, 'Base URL') },
  { id: 'act:help:copy-auth', title: '复制鉴权头', section: 'ACT', keywords: ['auth', 'header', 'bearer', '鉴权'], run: () => void copyText(AUTH_HEADER, '鉴权头') },
])
</script>


<template>
  <div class="ui-page help">
    <PageHead title="帮助" :status="status">
      <template #actions>
        <TxButton variant="secondary" size="sm" class="help__toc-btn" aria-haspopup="dialog" :aria-expanded="tocOpen" @click="tocOpen = true">
          目录 <Icon name="chev" :size="14" />
        </TxButton>
        <a class="ui-btn ui-btn--sm" href="/docs" target="_blank" rel="noopener">文档 ↗</a>
      </template>
    </PageHead>

    <div class="help__layout">
      <nav class="help__toc" aria-label="帮助目录">
        <a
          v-for="s in sections"
          :key="s.id"
          :href="`#${s.id}`"
          class="help__toc-row"
          :class="{ 'is-on': active === s.id }"
          :aria-current="active === s.id ? 'location' : undefined"
          @click.prevent="jump(s.id)"
        >{{ s.label }}</a>
      </nav>

      <div class="ui-grid help__body">
        <Plate id="start" tabindex="-1" class="help__sec c-12" title="开始之前" :state="startState" :rows="2" :cols="['1fr', '1fr']">
          <template #meta>
            <button v-if="settled(connect) && !info" type="button" class="ui-link" @click="connect.reload">重读配置</button>
          </template>
          <div class="help__fields">
            <CopyField label="OpenAI 兼容 Base URL" :value="base" :hint="baseHint" />
            <CopyField v-if="anthropicBase" label="Anthropic Base URL" :value="anthropicBase" hint="Claude Code · Anthropic SDK 用，不带 /v1" />
            <CopyField label="鉴权" :value="AUTH_HEADER" hint="Anthropic 协议也可用 x-api-key" />
            <CopyField label="环境变量" :value="EXPORT_SHOWN" :copy-value="EXPORT_COPY" hint="复制后把 Key 粘贴进引号 · 下面的示例都读它" />
          </div>
        </Plate>

        <Plate id="clients" tabindex="-1" class="help__sec c-12" title="调用示例" :state="clientsState" :rows="6" :cols="['1fr']">
          <div class="help__clients">
            <CodeSnippet v-model:variant="client" :variants="clients" :highlight="HIGHLIGHT" label="客户端" query="client" />
            <dl class="help__facts" :aria-label="`${currentClient.label} 要点`">
              <div v-for="f in currentClient.facts" :key="f.k" class="help__fact">
                <dt>{{ f.k }}</dt>
                <dd><Inline :text="f.v" /></dd>
              </div>
              <div class="help__fact">
                <dt>示例模型</dt>
                <dd>
                  <code class="help-ic">{{ currentClient.model }}</code>
                  <span class="help__fact-src">{{ inCatalog.has(currentClient.model) ? '可路由' : '默认示例 · 以 /v1/models 为准' }}</span>
                </dd>
              </div>
            </dl>
          </div>
        </Plate>

        <Plate id="models" tabindex="-1" class="help__sec c-6 md-c-12 stretch" title="检查模型">
          <template #meta>
            <RouterLink class="ui-link" to="/models">全部模型 →</RouterLink>
          </template>
          <ol class="help__steps">
            <li class="help__step">
              <span class="help__step-h" aria-hidden="true"><span class="help__step-n num">1</span>请求</span>
              <CodeSnippet :variants="check" :highlight="HIGHLIGHT" label="检查" />
            </li>
            <li class="help__step">
              <span class="help__step-h" aria-hidden="true"><span class="help__step-n num">2</span>应返回</span>
              <p class="help__note">
                <code class="help-ic">data[].id</code> 列表 · 把 id 原样填进 <code class="help-ic">model</code> · 每把 Key 只返回授权给它的模型
              </p>
            </li>
          </ol>
          <div class="help__inv">
            <StateBlock
              v-if="modelsState !== 'ready' && modelsState !== 'stale'"
              :state="modelsState"
              :rows="2"
              :cols="['1fr']"
              :error="catalog.error.value"
              title="网关目录读取失败"
              empty-text="启用渠道里没有开着的模型"
              action-label="去模型页"
              @retry="catalog.reload"
              @action="router.push('/models')"
            />
            <template v-else>
              <p class="help__inv-head">
                可路由 <b class="num">{{ fmtInt(inUse.length) }}</b> 个模型 · 按厂商
              </p>
              <ShareBar :segments="shares" :format="fmtInt" label="可路由模型按厂商" />
              <div class="help__examples">
                <span class="help__inv-k">示例里用到</span>
                <TxButton
                  v-for="id in exampleIds"
                  :key="id"
                  variant="ghost"
                  size="sm"
                  class="help__chip"
                  :aria-label="`复制模型 ${id}`"
                  :title="inCatalog.has(id) ? `复制 ${id}` : `${id} 不在可路由目录里 · 以 /v1/models 为准`"
                  @click="copyText(id, id)"
                >
                  <span class="ellip num">{{ id }}</span>
                  <span v-if="!inCatalog.has(id)" class="help__chip-def">默认</span>
                  <Icon name="copy" :size="12" />
                </TxButton>
              </div>
            </template>
          </div>
        </Plate>

        <Plate id="crapi" tabindex="-1" class="help__sec c-6 md-c-12 stretch" title="crapi 一键接入">
          <template #meta><TxTag label="推荐" size="sm" variant="plain" /></template>
          <p class="help__lead">识别本机已装的 Claude Code、Codex、Cursor、Cline 等客户端，一次写好 Base URL 与 Key。</p>
          <ol class="help__steps">
            <li class="help__step">
              <span class="help__step-h" aria-hidden="true"><span class="help__step-n num">1</span>安装</span>
              <CodeSnippet v-model:variant="crapiOs" :variants="CRAPI_INSTALL" label="系统" />
            </li>
            <li class="help__step">
              <span class="help__step-h" aria-hidden="true"><span class="help__step-n num">2</span>配置</span>
              <CodeSnippet :variants="crapiCmd" label="命令" />
            </li>
          </ol>
        </Plate>

        <Plate id="faq" tabindex="-1" class="help__sec c-12" title="常见问题">
          <template #meta>
            <button type="button" class="ui-link" :aria-pressed="allOpen" @click="toggleAll">{{ allOpen ? '全部收起' : '全部展开' }}</button>
          </template>
          <div class="help__faq">
            <TxCollapse v-for="(col, c) in faqCols" :key="c" class="help__faq-col" :model-value="colOpen[c]" @update:model-value="setCol(c, $event)">
              <TxCollapseItem v-for="f in col" :key="f.id" :name="f.id" class="help__qa">
                <template #title>
                  <span class="help__qa-q"><TxTag v-if="f.tag" :label="f.tag" size="sm" variant="plain" class="help__qa-tag" />{{ f.q }}</span>
                </template>
                <p class="help__qa-a">
                  <Inline :text="f.a" />
                  <RouterLink v-if="f.link" :to="f.link.to" class="ui-link help__qa-link">{{ f.link.label }}</RouterLink>
                </p>
              </TxCollapseItem>
            </TxCollapse>
          </div>
        </Plate>
      </div>
    </div>

    <Sheet v-model="tocOpen" title="目录" side="bottom">
      <nav class="help__sheet" aria-label="帮助目录">
        <a
          v-for="s in sections"
          :key="s.id"
          :href="`#${s.id}`"
          class="help__sheet-row"
          :class="{ 'is-on': active === s.id }"
          :aria-current="active === s.id ? 'location' : undefined"
          @click.prevent="jumpFromSheet(s.id)"
        >{{ s.label }}</a>
      </nav>
    </Sheet>
  </div>
</template>

<style scoped>
.help { --toc-w: 168px; --step-in: 72px; }
.help :deep(code.help-ic) { font-size: .92em; color: var(--ink); background: var(--paper-2); border-radius: var(--r-1); padding: 0 3px; overflow-wrap: anywhere; }

.help__layout { display: grid; grid-template-columns: var(--toc-w) minmax(0, 1fr); gap: 0 28px; align-items: start; min-width: 0; }
.help__body { min-width: 0; }
.help__sec { scroll-margin-top: calc(var(--head) + 16px); }
.help__sec:focus-visible { outline-offset: 4px !important; }

/* TOC rail (≥960): plain labels, the current one gets a fill and the signal edge */
.help__toc { position: sticky; top: calc(var(--head) + 16px); display: grid; gap: 2px; }
.help__toc-row,
.help__sheet-row {
  display: flex; align-items: center; min-height: 34px; padding: 0 12px; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: var(--fs-base); color: var(--ink-2);
  transition: background-color var(--dur-2) var(--ease-swift), color var(--dur-2);
}
.help__toc-row:hover, .help__sheet-row:hover { background: var(--paper-2); color: var(--ink); }
.help__toc-row.is-on, .help__sheet-row.is-on { background: var(--paper-2); color: var(--ink); font-weight: 600; box-shadow: inset 2px 0 0 var(--signal); }
/* (0,3,0): beats the button's own display */
.help .help__toc-btn { display: none; }
.help__toc-btn :deep(svg) { color: var(--ink-3); }

/* 开始之前 */
.help__fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 24px; padding-top: 12px; }

/* 调用示例: the snippet, and the selected client's facts beside it — spacing only, no rules */
.help__clients { display: grid; grid-template-columns: minmax(0, 1fr) 224px; gap: 0 24px; padding-top: 12px; min-width: 0; }
.help__clients > .ui-code { grid-template-rows: auto minmax(0, 1fr); }
.help__facts { margin: 0; padding-top: 44px; display: grid; align-content: start; gap: 12px; }
.help__fact { display: grid; gap: 2px; min-width: 0; }
.help__fact dt { font-size: var(--fs-xs); color: var(--ink-3); }
.help__fact dd { margin: 0; font-size: var(--fs-sm); color: var(--ink-2); min-width: 0; overflow-wrap: anywhere; }
.help__fact-src { margin-left: 6px; font-size: var(--fs-xs); color: var(--ink-3); }

/* steps (检查模型, crapi): the label rides on the snippet's tool bar, the code gets the full width */
.help__steps { list-style: none; margin: 12px 0 0; padding: 0; display: grid; gap: 12px; }
.help__step { position: relative; min-width: 0; }
.help__step-h {
  position: absolute; left: 0; top: 0; z-index: 1; height: var(--ctl-h); display: flex; align-items: center; gap: 6px;
  font-size: var(--fs-sm); font-weight: 600; color: var(--ink); white-space: nowrap; pointer-events: none;
}
.help__step-n { font-size: var(--fs-xs); font-weight: 400; color: var(--ink-3); }
.help__step :deep(.ui-code__bar) { min-height: var(--ctl-h); padding-left: var(--step-in); }
.help__note { margin: 0; min-height: var(--ctl-h); padding: 6px 0 0 var(--step-in); font-size: var(--fs-sm); line-height: 1.5; color: var(--ink-2); }
.help__lead { margin: 10px 0 0; font-size: var(--fs-sm); color: var(--ink-2); }

.help__inv { margin-top: 16px; display: grid; gap: 10px; min-width: 0; }
.help__inv-head { margin: 0; font-size: var(--fs-xs); color: var(--ink-3); }
.help__inv-head b { margin: 0 2px; font-size: var(--fs-md); font-weight: 600; color: var(--ink); }
.help__inv-k { font-size: var(--fs-xs); color: var(--ink-3); }
.help__examples { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 4px; min-width: 0; }
.help__examples .help__inv-k { margin-right: 4px; }
html:root .help .help__chip { max-width: 100%; padding: 0 6px; color: var(--ink); }
.help__chip :deep(svg) { flex: none; color: var(--ink-3); }
.help__chip-def { font-size: var(--fs-xs); color: var(--ink-3); }

/* 常见问题: two quiet disclosure columns */
.help__faq { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 32px; align-items: start; padding-top: 4px; }
.help__faq-col { min-width: 0; }
.help__qa-q { display: inline-flex; align-items: center; gap: 8px; min-width: 0; color: var(--ink); font-weight: 400; }
/* answers sit flush under the question; tuffex's 14px indent + 13px tail made each open row read as a box */
.help__qa :deep(.tx-collapse-item__content-inner) { padding: 0 24px 2px 0; }
.help__qa-a { margin: 0; font-size: var(--fs-sm); line-height: 1.6; color: var(--ink-2); }
.help__qa-link { margin-left: 6px; font-size: var(--fs-sm); }

/* sheet TOC (<960) */
.help__sheet { display: grid; gap: 2px; }
.help__sheet-row { min-height: 48px; font-size: var(--fs-row); }

@media (max-width: 1179px) {
  .help { --toc-w: 148px; }
  .help__layout { gap: 0 20px; }
}
@media (max-width: 959px) {
  .help__layout { grid-template-columns: minmax(0, 1fr); }
  .help__toc { display: none; }
  .help .help__toc-btn { display: inline-flex; }
  .help__clients { grid-template-columns: minmax(0, 1fr); }
  .help__facts { padding-top: 12px; gap: 6px; }
  .help__fact { grid-template-columns: 64px minmax(0, 1fr); gap: 8px; }
  .help__faq { grid-template-columns: minmax(0, 1fr); }
  .help__faq-col + .help__faq-col { border-top: 1px solid var(--rule); }
}
@media (max-width: 599px) {
  .help__fields { grid-template-columns: minmax(0, 1fr); }
  .help__note { padding: calc(var(--ctl-h) + 2px) 0 0; }
}
</style>
