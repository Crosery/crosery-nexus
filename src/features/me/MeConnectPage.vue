<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { TxIconButton } from '@talex-touch/tuffex/button'
import PageHead from '../../ui/shell/PageHead.vue'
import Plate from '../../ui/data/Plate.vue'
import CopyField from '../../ui/form/CopyField.vue'
import CodeSnippet from '../../ui/form/CodeSnippet.vue'
import MaskedKey from '../../ui/form/MaskedKey.vue'
import Icon from '../../ui/Icon.vue'
import { useLive } from '../../ui/composables/useLive'
import { copyText } from '../../ui/feedback/toast'
import { fmtInt } from '../../ui/fmt'
import { api } from '../../api'
import { byUse, callableCount, pickExample, usedText, type MeConnectX } from './meModel'
import type { MeModels } from '../../types'

/**
 * /me/connect (DESIGN §6.10): the base URLs, then three steps — export the key once, configure a client,
 * verify with /v1/models. Every snippet reads `$CROSERY_API_KEY`; the page never holds the full key (the
 * server only sends the masked tail), so step 1 copies an empty `export CROSERY_API_KEY=''` to paste into.
 * Example model ids are models this key can call: a client whose protocol has no callable model is not offered,
 * and with no callable model at all the snippets carry a `<模型 ID>` placeholder and say why.
 */
const connect = useLive<MeConnectX>((signal) => api.me.connect(signal) as Promise<MeConnectX>, { intervalMs: 0 })
const models = useLive<MeModels>((signal) => api.me.models(signal), {
  intervalMs: 0,
  isEmpty: (data) => data.models.length === 0,
})

const base = computed(() => connect.data.value?.baseUrl ?? '')
/** the server fell back to its own loopback address: say so instead of letting people copy it */
const unconfigured = computed(() => connect.data.value?.configured === false)
const anthropicBase = computed(() => connect.data.value?.anthropicBaseUrl ?? null)
const masked = computed(() => connect.data.value?.masked ?? '')
/** `sk-cr…7f3a` → head `sk-cr`, tail `7f3a` for the paste hint */
const maskedParts = computed(() => {
  const [head, tail] = masked.value.split('…')
  return head && tail ? { head, tail } : null
})

const callable = computed(() => models.data.value?.models ?? [])
const count = computed(() => callableCount(models.data.value))
const ranked = computed(() => [...callable.value].sort(byUse))
/** Claude Code speaks Anthropic Messages (claude-*); Codex speaks Responses (OpenAI models) */
const claudePick = computed(() => pickExample(callable.value, /^claude/i, /^claude-[a-z]+-\d/i))
const openaiPick = computed(() => pickExample(callable.value, /^(gpt|o\d)/i, /^gpt-\d/i))
/** chat/completions on the gateway serves every callable model: OpenAI first, else this key's most-used one */
const chatPick = computed(() => openaiPick.value ?? (ranked.value[0] ? { id: ranked.value[0].id, used: (ranked.value[0].used7d?.requests ?? 0) > 0 } : null))
const PLACEHOLDER = '<模型 ID>'
const chatModel = computed(() => chatPick.value?.id ?? PLACEHOLDER)
const examplesUsed = computed(() => Boolean(claudePick.value?.used || openaiPick.value?.used || chatPick.value?.used))
const exampleIds = computed(() => [...new Set([claudePick.value?.id, chatPick.value?.id].filter((id): id is string => Boolean(id)))])
const topIds = computed(() => ranked.value.slice(0, 6))

const exportStep = [{ id: 'export', label: '环境变量', code: "export CROSERY_API_KEY='…'", copyValue: "export CROSERY_API_KEY=''" }]

const clients = computed(() => {
  const b = base.value || 'https://<BASE_URL>/v1'
  const a = anthropicBase.value ?? b.replace(/\/v\d+$/, '')
  const claude = claudePick.value?.id
  const openai = openaiPick.value?.id
  const m = chatModel.value
  return [
    claude && { id: 'claude', label: 'Claude Code', code: `export ANTHROPIC_BASE_URL="${a}"\nexport ANTHROPIC_AUTH_TOKEN="$CROSERY_API_KEY"\nexport ANTHROPIC_MODEL="${claude}"\nclaude` },
    openai && { id: 'codex', label: 'Codex', code: `# ~/.codex/config.toml\nmodel = "${openai}"\nmodel_provider = "crosery"\n\n[model_providers.crosery]\nname = "Crosery"\nbase_url = "${b}"\nenv_key = "CROSERY_API_KEY"\nwire_api = "responses"` },
    { id: 'cursor', label: 'Cursor', code: `设置 → Models → OpenAI API Key\n  API Key:                   $CROSERY_API_KEY 的值\n  Override OpenAI Base URL:  ${b}\n  添加模型:                  ${m}` },
    { id: 'curl', label: 'curl', code: `curl ${b}/chat/completions \\\n  -H "Authorization: Bearer $CROSERY_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model": "${m}", "messages": [{"role": "user", "content": "你好"}]}'` },
    { id: 'python', label: 'Python', code: `import os\nfrom openai import OpenAI\n\nclient = OpenAI(base_url="${b}", api_key=os.environ["CROSERY_API_KEY"])\nreply = client.chat.completions.create(\n    model="${m}",\n    messages=[{"role": "user", "content": "你好"}],\n)\nprint(reply.choices[0].message.content)` },
    { id: 'node', label: 'Node', code: `import OpenAI from 'openai'\n\nconst client = new OpenAI({ baseURL: '${b}', apiKey: process.env.CROSERY_API_KEY })\nconst reply = await client.chat.completions.create({\n  model: '${m}',\n  messages: [{ role: 'user', content: '你好' }],\n})\nconsole.log(reply.choices[0].message.content)` },
  ].filter((variant): variant is { id: string; label: string; code: string } => Boolean(variant))
})
/** why there is no real example model (null = there is one, the ids are listed) */
const noExample = computed(() => {
  const m = models.data.value
  if (!m) return '示例模型读取中'
  if (m.reason === 'key_blocked') return '本 Key 额度已用完 · 暂时没有可调用的模型 · 恢复后这里换成真实模型'
  if (m.reason === 'gateway_unavailable') return '暂时读不到可调用的模型 · 把示例里的 <模型 ID> 换成「模型」页里的 ID'
  if (!callable.value.length) return '本 Key 没有可调用的模型 · 找管理员开通'
  return null
})
/** clients left out because this key cannot call a model of their protocol */
const hiddenClients = computed(() => {
  if (noExample.value) return ''
  const hidden = [!claudePick.value && 'Claude Code', !openaiPick.value && 'Codex'].filter(Boolean)
  return hidden.length ? `本 Key 没有 ${hidden.join(' / ')} 能用的模型 · 已省略` : ''
})

const verifyVariant = ref('list')
const verify = computed(() => {
  const b = base.value || 'https://<BASE_URL>/v1'
  return [
    { id: 'list', label: '模型列表', code: `curl ${b}/models \\\n  -H "Authorization: Bearer $CROSERY_API_KEY"` },
    { id: 'count', label: '只看数量', code: `curl -s ${b}/models \\\n  -H "Authorization: Bearer $CROSERY_API_KEY" | jq '.data | length'` },
  ]
})
const verifyHint = computed(() => {
  const m = models.data.value
  if (m?.reason === 'key_blocked') return '本 Key 额度已用完 · 恢复前会返回 401 / 429'
  const n = count.value
  // unknown count (not read yet, gateway unreadable): no number to expect
  if (n === null) return verifyVariant.value === 'count' ? '应输出一个数字 · 401 = Key 没设对' : '应返回模型列表 · 401 = Key 没设对'
  return verifyVariant.value === 'count' ? `应输出 ${fmtInt(n)}` : `应返回 ${fmtInt(n)} 个模型 · 401 = Key 没设对`
})
const modelsEmptyText = computed(() => {
  const reason = models.data.value?.reason
  if (reason === 'key_blocked') return '本 Key 额度已用完 · 恢复后可调用'
  if (reason === 'gateway_unavailable') return '暂时读不到模型列表 · 稍后重试'
  return '没有可调用的模型'
})
</script>

<template>
  <div class="ui-page me-connect">
    <PageHead title="接入" plain status="OpenAI / Anthropic 兼容 · 三步跑通">
      <template #actions><a class="ui-btn ui-btn--sm" href="/docs" target="_blank" rel="noopener">文档 ↗</a></template>
    </PageHead>

    <div class="me-connect__grid">
      <div class="me-connect__col me-connect__l">
        <Plate title="地址" class="me-connect__p1" :state="connect.state.value" :error="connect.error.value" :rows="3" @retry="connect.refresh">
          <div class="me-connect__fields">
            <CopyField label="Base URL · OpenAI 兼容" :value="base" />
            <CopyField v-if="anthropicBase" label="Base URL · Anthropic" :value="anthropicBase" />
            <p v-if="unconfigured" class="me-connect__warn" role="note"><span aria-hidden="true">◆</span> 公网地址未配置 · 这是服务器本机地址，在你的电脑上连不上 · 向管理员要地址</p>
            <MaskedKey :tail="masked" label="Key" />
          </div>
        </Plate>

        <Plate title="模型 ID" class="me-connect__p5" :state="models.state.value" :error="models.error.value" :rows="5" :empty-text="modelsEmptyText" @retry="models.refresh">
          <template #actions>
            <RouterLink v-if="callable.length" to="/me/models" class="ui-link">全部 {{ fmtInt(callable.length) }} 个 →</RouterLink>
          </template>
          <ul class="me-connect__ids">
            <li v-for="m in topIds" :key="m.id">
              <span class="me-connect__id num" :title="m.id">{{ m.id }}</span>
              <span class="me-connect__use num">{{ usedText(m.used7d) }}</span>
              <TxIconButton :label="`复制 ${m.id}`" :title="`复制 ${m.id}`" size="sm" @click="copyText(m.id, m.id)"><Icon name="copy" /></TxIconButton>
            </li>
          </ul>
        </Plate>
      </div>

      <div class="me-connect__col me-connect__r">
        <Plate title="第 1 步 · 设置 Key" class="me-connect__p2" :print="false">
          <CodeSnippet :variants="exportStep" label="环境变量" />
          <p class="me-connect__hint">
            把你的 Key 粘贴到引号里<template v-if="maskedParts"> · 以 <span class="num">{{ maskedParts.head }}</span> 开头、<span class="num">{{ maskedParts.tail }}</span> 结尾</template> · 写进 <span class="num">~/.zshrc</span> 长期生效
          </p>
        </Plate>

        <Plate title="第 2 步 · 配置客户端" class="me-connect__p3" :print="false">
          <CodeSnippet :variants="clients" label="客户端" query="client" />
          <p v-if="noExample" class="me-connect__hint">{{ noExample }}</p>
          <p v-else class="me-connect__hint">
            {{ examplesUsed ? '示例模型取自你最常用的' : '示例模型' }}：<template v-for="(id, i) in exampleIds" :key="id"><template v-if="i"> · </template><span class="num">{{ id }}</span></template>
            <template v-if="hiddenClients"><br />{{ hiddenClients }}</template>
          </p>
        </Plate>

        <Plate title="第 3 步 · 验证" class="me-connect__p4" :print="false">
          <CodeSnippet v-model:variant="verifyVariant" :variants="verify" label="验证方式" />
          <p class="me-connect__hint">{{ verifyHint }}</p>
        </Plate>
      </div>
    </div>
  </div>
</template>

<style>
.me-connect__grid { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: 26px var(--gutter); align-items: start; }
.me-connect__col { display: flex; flex-direction: column; gap: 26px; min-width: 0; }
.me-connect__l { grid-column: span 5; }
.me-connect__r { grid-column: span 7; }
.me-connect__fields { display: grid; gap: 12px; padding-top: 8px; }
.me-connect__hint { margin: 8px 0 0; font-size: var(--fs-xs); color: var(--ink-3); }
.me-connect__hint .num { color: var(--ink-2); }
.me-connect__warn { margin: 0; font-size: var(--fs-xs); color: var(--signal-ink); }
.me-connect__ids { list-style: none; margin: 0; padding: 0; }
.me-connect__ids li { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 12px; min-height: 40px; border-bottom: 1px solid var(--rule); }
.me-connect__ids li:last-child { border-bottom: 0; }
.me-connect__id { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink); }
.me-connect__use { font-size: var(--fs-xs); color: var(--ink-3); white-space: nowrap; }
@media (max-width: 1179px) {
  .me-connect__l { grid-column: span 5; }
  .me-connect__r { grid-column: span 7; }
}
@media (max-width: 959px) {
  .me-connect__grid { grid-template-columns: minmax(0, 1fr); gap: 22px; }
  .me-connect__col { display: contents; }
  .me-connect__p1 { order: 1; } .me-connect__p2 { order: 2; } .me-connect__p3 { order: 3; } .me-connect__p4 { order: 4; } .me-connect__p5 { order: 5; }
}
@media (max-width: 599px) {
  .me-connect__use { display: none; }
}
</style>
