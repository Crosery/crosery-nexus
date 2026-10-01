<script setup lang="ts">
/**
 * `/docs` 独立文档页（原 `src/docs.tsx` 的 Vue 迁移，task-43）。
 *
 * 迁移原则：**内容与结构照搬**，class 名与 `docs.css` 完全复用（该页是独立入口、
 * 自带一套暖灰配色，不属于控制台外壳的排版体系），图标从 `lucide-react` 换成项目在用的
 * UnoCSS 图标（`i-carbon-*`），因此可以彻底移除 React 全家桶依赖。
 */
import { h, ref, type FunctionalComponent } from 'vue'
import '../docs.css'

const BASE_URL = 'https://ai.crosery.com/v1'
const USAGE_URL = 'https://console.ai.crosery.com/v1'

type IconName = string

const NAV: Array<{ id: string; label: string; icon: IconName }> = [
  { id: 'start', label: '开始使用', icon: 'i-carbon-password' },
  { id: 'crapi', label: 'crapi 一键接入（推荐）', icon: 'i-carbon-magic-wand' },
  { id: 'models', label: '列出模型', icon: 'i-carbon-data-base' },
  { id: 'openai', label: 'OpenAI 聊天', icon: 'i-carbon-chat' },
  { id: 'anthropic', label: 'Anthropic 原生', icon: 'i-carbon-terminal' },
  { id: 'responses', label: 'Responses / Codex', icon: 'i-carbon-data-base' },
  { id: 'images', label: '图片生成', icon: 'i-carbon-image' },
  { id: 'usage', label: '自助用量查询', icon: 'i-carbon-activity' },
  { id: 'quota', label: '额度与刷新', icon: 'i-carbon-meter' },
  { id: 'clients', label: '客户端配置', icon: 'i-carbon-terminal' },
]

const menuOpen = ref(false)
const copiedId = ref('')

async function copyText(text: string, id: string) {
  try {
    await navigator.clipboard.writeText(text)
    copiedId.value = id
    window.setTimeout(() => {
      if (copiedId.value === id) copiedId.value = ''
    }, 1600)
  } catch {
    // 剪贴板不可用（非用户手势/权限被拒）时不假装成功：保持「复制」原文案。
    copiedId.value = ''
  }
}

/** 图标：UnoCSS 图标类，尺寸沿用原来 lucide 的 size 语义（font-size 驱动）。 */
const Icon: FunctionalComponent<{ name: IconName; size?: number }> = (props) =>
  h('span', { class: [props.name, 'docs-ico'], style: { fontSize: `${props.size ?? 16}px` }, 'aria-hidden': 'true' })

/** 代码块 + 复制按钮（对应原来的 `Code` 组件）。 */
const Code: FunctionalComponent<{ label: string; code: string; id: string }> = (props) =>
  h('div', { class: 'docs-code' }, [
    h('div', { class: 'docs-code-head' }, [
      h('span', null, props.label),
      h(
        'button',
        {
          type: 'button',
          onClick: () => void copyText(props.code, props.id),
        },
        [
          h(Icon, { name: copiedId.value === props.id ? 'i-carbon-checkmark' : 'i-carbon-copy', size: 14 }),
          copiedId.value === props.id ? '已复制' : '复制',
        ],
      ),
    ]),
    h('pre', null, [h('code', null, props.code)]),
  ])

/** 每个代码块的内容（**逐字**取自迁移前的 `docs.tsx`）。 */

const CODE_0 = `curl -fsSL https://cdn.jsdelivr.net/gh/crosery/crapi/install.sh | sh`

const CODE_1 = `irm https://cdn.jsdelivr.net/gh/crosery/crapi/install.ps1 | iex`

const CODE_2 = `# 自动检测本机所有已安装客户端并一键完成配置接入
crapi setup

# 快速统一切换所有工具的默认主力模型
crapi use claude-opus-5-5

# 从网关拉取最新模型和渠道
crapi update`

const CODE_3 = `curl ${BASE_URL}/models \\
  -H "Authorization: Bearer $CROSERY_API_KEY"`

const CODE_4 = `curl ${BASE_URL}/chat/completions \\
  -H "Authorization: Bearer $CROSERY_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-5.4-mini",
    "messages": [{"role": "user", "content": "你好"}]
  }'`

const CODE_5 = `from openai import OpenAI

client = OpenAI(api_key="<你的 KEY>", base_url="${BASE_URL}")
response = client.chat.completions.create(
    model="gpt-5.4-mini",
    messages=[{"role": "user", "content": "你好"}],
)
print(response.choices[0].message.content)`

const CODE_6 = `curl ${BASE_URL}/messages \\
  -H "x-api-key: $CROSERY_API_KEY" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "claude-sonnet-5",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "你好"}]
  }'`

const CODE_7 = `export ANTHROPIC_BASE_URL="https://ai.crosery.com"
export ANTHROPIC_AUTH_TOKEN="<你的 KEY>"
claude`

const CODE_8 = `curl ${BASE_URL}/responses \\
  -H "Authorization: Bearer $CROSERY_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "gpt-5.4-mini", "input": "你好"}'`

const CODE_9 = `model = "gpt-5.4-mini"
model_provider = "crosery"

[model_providers.crosery]
name = "Crosery"
base_url = "https://ai.crosery.com/v1"
env_key = "CROSERY_API_KEY"
wire_api = "responses"`

const CODE_10 = `curl ${BASE_URL}/images/generations \\
  -H "Authorization: Bearer $CROSERY_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-image-2",
    "prompt": "一只在屋顶上的橘猫，水彩风格",
    "n": 1,
    "size": "1024x1024"
  }'`

const CODE_11 = `import base64
from openai import OpenAI

client = OpenAI(api_key="<你的 KEY>", base_url="${BASE_URL}")
result = client.images.generate(
    model="gpt-image-2",
    prompt="一只在屋顶上的橘猫，水彩风格",
    size="1024x1024",
)
open("output.png", "wb").write(base64.b64decode(result.data[0].b64_json))`

const CODE_12 = `curl "${USAGE_URL}/usage?days=30" \\
  -H "Authorization: Bearer $CROSERY_API_KEY"`

const CODE_13 = `curl "${USAGE_URL}/usage/requests?days=7&limit=50" \\
  -H "Authorization: Bearer $CROSERY_API_KEY"`

function closeMenu() {
  menuOpen.value = false
}
</script>

<template>
  <div class="docs-app">
    <header class="docs-topbar">
      <a href="/docs" class="docs-brand">
        <span>✦</span>
        <div><strong>Crosery</strong><small>API 文档</small></div>
      </a>
      <nav>
        <a href="#models">接口总览</a>
        <a class="docs-cta" href="#start">开始接入 <Icon name="i-carbon-chevron-right" :size="15" /></a>
      </nav>
      <button
        type="button"
        class="docs-menu-button"
        aria-label="切换文档目录"
        :aria-expanded="menuOpen"
        @click="menuOpen = !menuOpen"
      >
        <Icon :name="menuOpen ? 'i-carbon-close' : 'i-carbon-menu'" :size="20" />
      </button>
    </header>

    <div class="docs-shell">
      <aside :class="menuOpen ? 'docs-sidebar open' : 'docs-sidebar'">
        <p>文档目录</p>
        <a v-for="item in NAV" :key="item.id" :href="`#${item.id}`" @click="closeMenu">
          <Icon :name="item.icon" :size="15" />{{ item.label }}
        </a>
        <div class="docs-sidebar-foot"><span />Gateway 状态正常</div>
      </aside>

      <main class="docs-main">
        <section class="docs-hero">
          <p>API DOCUMENTATION</p>
          <h1>拿到 API Key 后<br />直接发请求</h1>
          <div>无需登录控制台也能查模型、调用文本与图片接口、查询自己 Key 的额度和用量。所有地址、鉴权和返回格式都在本页。</div>
          <div class="docs-hero-actions">
            <a class="docs-primary" href="#models">先列出模型 <Icon name="i-carbon-chevron-right" :size="16" /></a>
            <a class="docs-secondary" href="#usage">查询用量</a>
          </div>
        </section>

        <section id="start" class="docs-section">
          <header>
            <span class="docs-section-icon"><Icon name="i-carbon-password" :size="18" /></span>
            <div><h2>开始使用</h2><p>只需要一把 API Key；本页所有业务接口都使用同一套 Bearer 鉴权</p></div>
          </header>
          <div class="docs-facts">
            <div><span>API Base URL</span><code>{{ BASE_URL }}</code></div>
            <div><span>通用鉴权</span><code>Authorization: Bearer &lt;API_KEY&gt;</code></div>
            <div><span>请求格式</span><code>Content-Type: application/json</code></div>
            <div><span>先做什么</span><code>GET {{ BASE_URL }}/models</code></div>
          </div>
          <div class="docs-callout">
            <Icon name="i-carbon-password" :size="17" />
            <p>文本、图片和模型接口使用 <code>ai.crosery.com/v1</code>；自助用量接口使用 <code>console.ai.crosery.com/v1</code>。如果你已经拿到了 API Key，不需要登录控制台：先调用模型目录，再把返回的 <code>data[].id</code> 作为请求中的 <code>model</code>。</p>
          </div>
        </section>

        <section id="crapi" class="docs-section">
          <header>
            <span class="docs-section-icon"><Icon name="i-carbon-magic-wand" :size="18" /></span>
            <div><h2>crapi 一键接入 CLI（推荐）</h2><p>无需手动配置各客户端或使用 ccswitch，一行命令全自动适配本机所有 Agent 环境</p></div>
          </header>
          <div class="docs-callout">
            <Icon name="i-carbon-magic-wand" :size="17" />
            <p><strong>crapi</strong> 是小鸡云 CPA / crosery 渠道的专用配置工具。自动扫描识别本机已安装的 Agent CLI 和客户端（Claude Code、Codex CLI、Cursor、Windsurf、Cline、Roo Code、Cherry Studio 等），一键配置 Base URL 与 Key，支持模型热切换与号池/用量监控。</p>
          </div>
          <component :is="Code" :label="'macOS / Linux 一键安装'" :code="CODE_0" id="c0" />
          <component :is="Code" :label="'Windows PowerShell 一键安装'" :code="CODE_1" id="c1" />
          <component :is="Code" :label="'常用命令'" :code="CODE_2" id="c2" />
        </section>

        <section id="models" class="docs-section">
          <header>
            <span class="docs-section-icon"><Icon name="i-carbon-data-base" :size="18" /></span>
            <div><h2>列出当前 Key 可用模型</h2><p>每次调用前可用它确认模型名称和图片模型权限</p></div>
          </header>
          <component :is="Code" :label="'curl · GET /v1/models'" :code="CODE_3" id="c3" />
          <div class="docs-card-grid">
            <div class="docs-card"><strong>成功响应</strong><p>返回 <code>data</code> 数组；将每项的 <code>id</code> 原样填入聊天、Responses 或图片请求的 <code>model</code> 字段。</p></div>
            <div class="docs-card"><strong>401 无效 Key</strong><p>确认 Header 是 <code>Authorization: Bearer</code>，不要把 Key 写进 URL 或请求体。</p></div>
            <div class="docs-card"><strong>403 无模型权限</strong><p>该 Key 没有该模型的调用权限。重新执行本接口，只使用当前返回的模型名。</p></div>
            <div class="docs-card"><strong>图片模型</strong><p>在 <code>data[].id</code> 中选择包含 <code>image</code> 的模型，再请求图片生成端点。</p></div>
          </div>
        </section>

        <section id="openai" class="docs-section">
          <header>
            <span class="docs-section-icon"><Icon name="i-carbon-chat" :size="18" /></span>
            <div><h2>OpenAI 聊天接口</h2><p>/v1/chat/completions，适用于多数 OpenAI 兼容客户端</p></div>
          </header>
          <component :is="Code" :label="'curl'" :code="CODE_4" id="c4" />
          <component :is="Code" :label="'Python · openai SDK'" :code="CODE_5" id="c5" />
          <div class="docs-card-grid">
            <div class="docs-card"><strong>必填字段</strong><p><code>model</code> 和 <code>messages</code>。模型名必须来自 <a href="#models">模型目录</a>。</p></div>
            <div class="docs-card"><strong>普通响应</strong><p>从 <code>choices[0].message.content</code> 读取文本结果。</p></div>
            <div class="docs-card"><strong>流式响应</strong><p>请求体增加 <code>"stream": true</code>，按标准 SSE 逐段读取 <code>data:</code>。</p></div>
            <div class="docs-card"><strong>常见错误</strong><p><code>401</code> 代表 Key 无效；<code>403 model_not_allowed</code> 代表模型未授权；<code>429</code> 代表上游或并发限制。</p></div>
          </div>
          <p class="docs-note">Claude 模型也支持此接口，只需把 <code>model</code> 替换为当前 Key 可见的 Claude 模型名。</p>
        </section>

        <section id="anthropic" class="docs-section">
          <header>
            <span class="docs-section-icon"><Icon name="i-carbon-terminal" :size="18" /></span>
            <div><h2>Anthropic 原生接口</h2><p>/v1/messages，适用于 Anthropic SDK 和 Claude Code</p></div>
          </header>
          <component :is="Code" :label="'curl'" :code="CODE_6" id="c6" />
          <component :is="Code" :label="'Claude Code'" :code="CODE_7" id="c7" />
          <div class="docs-card-grid">
            <div class="docs-card"><strong>必填字段</strong><p><code>model</code>、<code>max_tokens</code> 和 <code>messages</code>。</p></div>
            <div class="docs-card"><strong>鉴权</strong><p>优先使用 <code>x-api-key</code>；也可使用标准 <code>Authorization: Bearer</code>。</p></div>
            <div class="docs-card"><strong>返回文本</strong><p>从 Anthropic 响应的 <code>content[0].text</code> 读取回答。</p></div>
            <div class="docs-card"><strong>Claude Code</strong><p>Base URL 不带 <code>/v1</code>，客户端会自动补齐。</p></div>
          </div>
        </section>

        <section id="responses" class="docs-section">
          <header>
            <span class="docs-section-icon"><Icon name="i-carbon-data-base" :size="18" /></span>
            <div><h2>Responses / Codex 接口</h2><p>/v1/responses，适用于 Codex CLI 和新版 OpenAI SDK</p></div>
          </header>
          <component :is="Code" :label="'curl'" :code="CODE_8" id="c8" />
          <div class="docs-card-grid">
            <div class="docs-card"><strong>必填字段</strong><p><code>model</code> 与 <code>input</code>；这里使用 <code>input</code>，不是 <code>messages</code>。</p></div>
            <div class="docs-card"><strong>返回文本</strong><p>从 <code>output</code> 数组中读取输出项；新版 SDK 可直接使用其聚合文本字段。</p></div>
            <div class="docs-card"><strong>流式响应</strong><p>增加 <code>"stream": true</code> 后按 SSE 读取事件。</p></div>
            <div class="docs-card"><strong>普通聊天</strong><p>多数聊天客户端应使用 <a href="#openai">chat/completions</a>。</p></div>
          </div>
          <component :is="Code" :label="'~/.codex/config.toml'" :code="CODE_9" id="c9" />
        </section>

        <section id="images" class="docs-section">
          <header>
            <span class="docs-section-icon"><Icon name="i-carbon-image" :size="18" /></span>
            <div><h2>图片生成</h2><p>/v1/images/generations，生成结果以 base64 PNG 返回</p></div>
          </header>
          <component :is="Code" :label="'curl'" :code="CODE_10" id="c10" />
          <component :is="Code" :label="'Python · 保存 PNG'" :code="CODE_11" id="c11" />
          <div class="docs-card-grid">
            <div class="docs-card"><strong>必填字段</strong><p><code>model</code>、<code>prompt</code>；示例的 <code>n</code> 与 <code>size</code> 可按模型支持范围调整。</p></div>
            <div class="docs-card"><strong>结果格式</strong><p>从 <code>data[0].b64_json</code> 读取 base64 字符串，解码后保存为 PNG。没有 <code>url</code> 字段。</p></div>
            <div class="docs-card"><strong>模型权限</strong><p>先执行 <a href="#models">GET /v1/models</a>，仅使用列表中存在的图片模型。无权限时返回 <code>403</code>。</p></div>
            <div class="docs-card"><strong>超时与重试</strong><p>客户端超时至少设为 120 秒；超时后先请求自己的用量，再决定是否重试，避免重复生成。</p></div>
          </div>
        </section>

        <section id="usage" class="docs-section">
          <header>
            <span class="docs-section-icon"><Icon name="i-carbon-activity" :size="18" /></span>
            <div><h2>不登录控制台也能查询自己的用量</h2><p>业务 API Key 只能读取它自己的记录、额度和最近请求；不会暴露其他 Key 或管理数据</p></div>
          </header>
          <component :is="Code" :label="'汇总、逐模型 Token、估算花费和额度 · GET /v1/usage'" :code="CODE_12" id="c12" />
          <component :is="Code" :label="'最近请求明细 · GET /v1/usage/requests'" :code="CODE_13" id="c13" />
          <div class="docs-card-grid">
            <div class="docs-card"><strong>汇总返回</strong><p>包含 <code>models</code>、输入/输出/缓存 Token、分项花费、<code>unpricedModels</code>、当前 Key 的 <code>quota</code> 与额度刷新时间。</p></div>
            <div class="docs-card"><strong>请求明细返回</strong><p>包含时间、模型、端点、状态码、总耗时、首 Token 时间、Token 明细与上游请求 ID；不返回错误正文或其他 Key 信息。</p></div>
            <div class="docs-card"><strong>参数范围</strong><p><code>days</code> 为 1 到保留期限，汇总默认 30 天、明细默认 7 天；<code>limit</code> 为 1–200，默认 50。</p></div>
            <div class="docs-card"><strong>安全边界</strong><p>必须使用该业务 Key 的 <code>Authorization: Bearer</code>。Key 已被人工停用时返回 <code>401</code>；因额度超限而暂停的 Key 仍可查用量与额度。</p></div>
          </div>
          <p class="docs-note">未定价模型会出现在 <code>unpricedModels</code>，但不纳入金额合计，也不会以猜测金额触发额度拦截。</p>
        </section>

        <section id="quota" class="docs-section">
          <header>
            <span class="docs-section-icon"><Icon name="i-carbon-meter" :size="18" /></span>
            <div><h2>额度与自动刷新</h2><p>额度状态包含在 GET {{ USAGE_URL }}/usage 的 quota 字段中；无需登录控制台</p></div>
          </header>
          <div class="docs-card-grid">
            <div class="docs-card"><strong>日额度</strong><p>按 <strong>Asia/Shanghai</strong> 结算，<strong>每天 00:00</strong> 自动刷新。</p></div>
            <div class="docs-card"><strong>周额度</strong><p>按同一时区结算，<strong>每周一 00:00</strong> 自动刷新。</p></div>
            <div class="docs-card"><strong>总额度</strong><p>从创建或上次手动重置起累计，<strong>不会自动刷新</strong>。</p></div>
            <div class="docs-card"><strong>超额行为</strong><p>任一窗口超额时网关拒绝新调用；额度查询仍可读取当前花费、上限与下次刷新时间。</p></div>
          </div>
          <p class="docs-note">图片模型会将图像输入、图像输出等 token 写入网关的输入、输出、缓存字段，并据此结算。没有公开数字价卡的模型会标记为未定价，不会按猜测金额触发额度停用。</p>
        </section>

        <section id="clients" class="docs-section">
          <header>
            <span class="docs-section-icon"><Icon name="i-carbon-send" :size="18" /></span>
            <div><h2>客户端配置</h2><p>大多数 OpenAI 兼容客户端仅需填写地址、Key 和从模型目录返回的模型名</p></div>
          </header>
          <div class="docs-card-grid">
            <div class="docs-card"><strong>Cherry Studio / Chatbox / NextChat</strong><p>服务商选择“OpenAI 兼容”，API 地址填 <code>{{ BASE_URL }}</code>，填写已有 Key 后先刷新模型列表。</p></div>
            <div class="docs-card"><strong>环境变量</strong><p><code>OPENAI_BASE_URL={{ BASE_URL }}</code><br /><code>OPENAI_API_KEY=&lt;你的 KEY&gt;</code></p></div>
            <div class="docs-card"><strong>流式请求</strong><p>Chat 或 Responses 请求体添加 <code>"stream": true</code>，按 SSE 分块读取。</p></div>
            <div class="docs-card"><strong>无法登录控制台</strong><p>不影响 API 使用。用 <a href="#models">GET /v1/models</a>、<a href="#usage">GET /v1/usage</a> 和 <a href="#usage">GET /v1/usage/requests</a> 完成模型、额度和请求自查。</p></div>
          </div>
        </section>

        <footer class="docs-footer">
          <div><strong>Crosery API</strong><span>已有 Key 即可通过本页接口完成模型、调用、用量和额度自查。</span></div>
          <a href="#models">从模型目录开始 <Icon name="i-carbon-chevron-right" :size="15" /></a>
        </footer>
      </main>
    </div>
  </div>
</template>

<style>
/* 图标尺寸由 font-size 驱动（见脚本里的 Icon 组件）；其余样式沿用 docs.css。 */
.docs-ico {
  display: inline-block;
  width: 1em;
  height: 1em;
  vertical-align: -0.15em;
}
.docs-code-head button .docs-ico {
  margin-right: 6px;
}
</style>
