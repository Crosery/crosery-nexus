import { Activity, Check, ChevronRight, Copy, Database, Gauge, Image as ImageIcon, KeyRound, Menu, MessageSquare, Send, Terminal, X } from 'lucide-react'
import { useState } from 'react'
import './docs.css'

const BASE_URL = 'https://ai.crosery.com/v1'
const USAGE_URL = 'https://console.ai.crosery.com/v1'

type DocId = 'start' | 'models' | 'openai' | 'anthropic' | 'responses' | 'images' | 'usage' | 'quota' | 'clients'

const NAV: Array<{ id: DocId; label: string; icon: typeof Terminal }> = [
  { id: 'start', label: '开始使用', icon: KeyRound },
  { id: 'models', label: '列出模型', icon: Database },
  { id: 'openai', label: 'OpenAI 聊天', icon: MessageSquare },
  { id: 'anthropic', label: 'Anthropic 原生', icon: Terminal },
  { id: 'responses', label: 'Responses / Codex', icon: Database },
  { id: 'images', label: '图片生成', icon: ImageIcon },
  { id: 'usage', label: '自助用量查询', icon: Activity },
  { id: 'quota', label: '额度与刷新', icon: Gauge },
  { id: 'clients', label: '客户端配置', icon: Terminal },
]

function Code({ label, children }: { label: string; children: string }) {
  const [copied, setCopied] = useState(false)
  return <div className="docs-code">
    <div className="docs-code-head"><span>{label}</span><button type="button" onClick={async () => { await navigator.clipboard.writeText(children); setCopied(true); setTimeout(() => setCopied(false), 1600) }}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? '已复制' : '复制'}</button></div>
    <pre><code>{children}</code></pre>
  </div>
}

function DocSection({ id, icon: Icon, title, subtitle, children }: { id: DocId; icon: typeof Terminal; title: string; subtitle: string; children: React.ReactNode }) {
  return <section id={id} className="docs-section">
    <header><span className="docs-section-icon"><Icon size={18} /></span><div><h2>{title}</h2><p>{subtitle}</p></div></header>
    {children}
  </section>
}

function DocCard({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="docs-card"><strong>{title}</strong><p>{children}</p></div>
}

export default function DocsApp() {
  const [menuOpen, setMenuOpen] = useState(false)
  const closeMenu = () => setMenuOpen(false)
  return <div className="docs-app">
    <header className="docs-topbar">
      <a href="/docs" className="docs-brand"><span>✦</span><div><strong>Crosery</strong><small>API 文档</small></div></a>
      <nav><a href="#models">接口总览</a><a className="docs-cta" href="#start">开始接入 <ChevronRight size={15} /></a></nav>
      <button type="button" className="docs-menu-button" aria-label="切换文档目录" onClick={() => setMenuOpen((value) => !value)}>{menuOpen ? <X size={20} /> : <Menu size={20} />}</button>
    </header>

    <div className="docs-shell">
      <aside className={menuOpen ? 'docs-sidebar open' : 'docs-sidebar'}>
        <p>文档目录</p>
        {NAV.map(({ id, label, icon: Icon }) => <a key={id} href={`#${id}`} onClick={closeMenu}><Icon size={15} />{label}</a>)}
        <div className="docs-sidebar-foot"><span />Gateway 状态正常</div>
      </aside>

      <main className="docs-main">
        <section className="docs-hero">
          <p>API DOCUMENTATION</p>
          <h1>拿到 API Key 后<br />直接发请求</h1>
          <div>无需登录控制台也能查模型、调用文本与图片接口、查询自己 Key 的额度和用量。所有地址、鉴权和返回格式都在本页。</div>
          <div className="docs-hero-actions"><a className="docs-primary" href="#models">先列出模型 <ChevronRight size={16} /></a><a className="docs-secondary" href="#usage">查询用量</a></div>
        </section>

        <DocSection id="start" icon={KeyRound} title="开始使用" subtitle="只需要一把 API Key；本页所有业务接口都使用同一套 Bearer 鉴权">
          <div className="docs-facts">
            <div><span>API Base URL</span><code>{BASE_URL}</code></div>
            <div><span>通用鉴权</span><code>Authorization: Bearer &lt;API_KEY&gt;</code></div>
            <div><span>请求格式</span><code>Content-Type: application/json</code></div>
            <div><span>先做什么</span><code>GET {BASE_URL}/models</code></div>
          </div>
          <div className="docs-callout"><KeyRound size={17} /><p>文本、图片和模型接口使用 <code>ai.crosery.com/v1</code>；自助用量接口使用 <code>console.ai.crosery.com/v1</code>。如果你已经拿到了 API Key，不需要登录控制台：先调用模型目录，再把返回的 <code>data[].id</code> 作为请求中的 <code>model</code>。</p></div>
        </DocSection>

        <DocSection id="models" icon={Database} title="列出当前 Key 可用模型" subtitle="每次调用前可用它确认模型名称和图片模型权限">
          <Code label="curl · GET /v1/models">{`curl ${BASE_URL}/models \\
  -H "Authorization: Bearer $CROSERY_API_KEY"`}</Code>
          <div className="docs-card-grid"><DocCard title="成功响应">返回 <code>data</code> 数组；将每项的 <code>id</code> 原样填入聊天、Responses 或图片请求的 <code>model</code> 字段。</DocCard><DocCard title="401 无效 Key">确认 Header 是 <code>Authorization: Bearer</code>，不要把 Key 写进 URL 或请求体。</DocCard><DocCard title="403 无模型权限">该 Key 没有该模型的调用权限。重新执行本接口，只使用当前返回的模型名。</DocCard><DocCard title="图片模型">在 <code>data[].id</code> 中选择包含 <code>image</code> 的模型，再请求图片生成端点。</DocCard></div>
        </DocSection>

        <DocSection id="openai" icon={MessageSquare} title="OpenAI 聊天接口" subtitle="/v1/chat/completions，适用于多数 OpenAI 兼容客户端">
          <Code label="curl">{`curl ${BASE_URL}/chat/completions \\
  -H "Authorization: Bearer $CROSERY_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-5.4-mini",
    "messages": [{"role": "user", "content": "你好"}]
  }'`}</Code>
          <Code label="Python · openai SDK">{`from openai import OpenAI

client = OpenAI(api_key="<你的 KEY>", base_url="${BASE_URL}")
response = client.chat.completions.create(
    model="gpt-5.4-mini",
    messages=[{"role": "user", "content": "你好"}],
)
print(response.choices[0].message.content)`}</Code>
          <div className="docs-card-grid"><DocCard title="必填字段"><code>model</code> 和 <code>messages</code>。模型名必须来自 <a href="#models">模型目录</a>。</DocCard><DocCard title="普通响应">从 <code>choices[0].message.content</code> 读取文本结果。</DocCard><DocCard title="流式响应">请求体增加 <code>"stream": true</code>，按标准 SSE 逐段读取 <code>data:</code>。</DocCard><DocCard title="常见错误"><code>401</code> 代表 Key 无效；<code>403 model_not_allowed</code> 代表模型未授权；<code>429</code> 代表上游或并发限制。</DocCard></div>
          <p className="docs-note">Claude 模型也支持此接口，只需把 <code>model</code> 替换为当前 Key 可见的 Claude 模型名。</p>
        </DocSection>

        <DocSection id="anthropic" icon={Terminal} title="Anthropic 原生接口" subtitle="/v1/messages，适用于 Anthropic SDK 和 Claude Code">
          <Code label="curl">{`curl ${BASE_URL}/messages \\
  -H "x-api-key: $CROSERY_API_KEY" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "claude-sonnet-5",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "你好"}]
  }'`}</Code>
          <Code label="Claude Code">{`export ANTHROPIC_BASE_URL="https://ai.crosery.com"
export ANTHROPIC_AUTH_TOKEN="<你的 KEY>"
claude`}</Code>
          <div className="docs-card-grid"><DocCard title="必填字段"><code>model</code>、<code>max_tokens</code> 和 <code>messages</code>。</DocCard><DocCard title="鉴权">优先使用 <code>x-api-key</code>；也可使用标准 <code>Authorization: Bearer</code>。</DocCard><DocCard title="返回文本">从 Anthropic 响应的 <code>content[0].text</code> 读取回答。</DocCard><DocCard title="Claude Code">Base URL 不带 <code>/v1</code>，客户端会自动补齐。</DocCard></div>
        </DocSection>

        <DocSection id="responses" icon={Database} title="Responses / Codex 接口" subtitle="/v1/responses，适用于 Codex CLI 和新版 OpenAI SDK">
          <Code label="curl">{`curl ${BASE_URL}/responses \\
  -H "Authorization: Bearer $CROSERY_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "gpt-5.4-mini", "input": "你好"}'`}</Code>
          <div className="docs-card-grid"><DocCard title="必填字段"><code>model</code> 与 <code>input</code>；这里使用 <code>input</code>，不是 <code>messages</code>。</DocCard><DocCard title="返回文本">从 <code>output</code> 数组中读取输出项；新版 SDK 可直接使用其聚合文本字段。</DocCard><DocCard title="流式响应">增加 <code>"stream": true</code> 后按 SSE 读取事件。</DocCard><DocCard title="普通聊天">多数聊天客户端应使用 <a href="#openai">chat/completions</a>。</DocCard></div>
          <Code label="~/.codex/config.toml">{`model = "gpt-5.4-mini"
model_provider = "crosery"

[model_providers.crosery]
name = "Crosery"
base_url = "https://ai.crosery.com/v1"
env_key = "CROSERY_API_KEY"
wire_api = "responses"`}</Code>
        </DocSection>

        <DocSection id="images" icon={ImageIcon} title="图片生成" subtitle="/v1/images/generations，生成结果以 base64 PNG 返回">
          <Code label="curl">{`curl ${BASE_URL}/images/generations \\
  -H "Authorization: Bearer $CROSERY_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-image-2",
    "prompt": "一只在屋顶上的橘猫，水彩风格",
    "n": 1,
    "size": "1024x1024"
  }'`}</Code>
          <Code label="Python · 保存 PNG">{`import base64
from openai import OpenAI

client = OpenAI(api_key="<你的 KEY>", base_url="${BASE_URL}")
result = client.images.generate(
    model="gpt-image-2",
    prompt="一只在屋顶上的橘猫，水彩风格",
    size="1024x1024",
)
open("output.png", "wb").write(base64.b64decode(result.data[0].b64_json))`}</Code>
          <div className="docs-card-grid"><DocCard title="必填字段"><code>model</code>、<code>prompt</code>；示例的 <code>n</code> 与 <code>size</code> 可按模型支持范围调整。</DocCard><DocCard title="结果格式">从 <code>data[0].b64_json</code> 读取 base64 字符串，解码后保存为 PNG。没有 <code>url</code> 字段。</DocCard><DocCard title="模型权限">先执行 <a href="#models">GET /v1/models</a>，仅使用列表中存在的图片模型。无权限时返回 <code>403</code>。</DocCard><DocCard title="超时与重试">客户端超时至少设为 120 秒；超时后先请求自己的用量，再决定是否重试，避免重复生成。</DocCard></div>
        </DocSection>

        <DocSection id="usage" icon={Activity} title="不登录控制台也能查询自己的用量" subtitle="业务 API Key 只能读取它自己的记录、额度和最近请求；不会暴露其他 Key 或管理数据">
          <Code label="汇总、逐模型 Token、估算花费和额度 · GET /v1/usage">{`curl "${USAGE_URL}/usage?days=30" \\
  -H "Authorization: Bearer $CROSERY_API_KEY"`}</Code>
          <Code label="最近请求明细 · GET /v1/usage/requests">{`curl "${USAGE_URL}/usage/requests?days=7&limit=50" \\
  -H "Authorization: Bearer $CROSERY_API_KEY"`}</Code>
          <div className="docs-card-grid"><DocCard title="汇总返回">包含 <code>models</code>、输入/输出/缓存 Token、分项花费、<code>unpricedModels</code>、当前 Key 的 <code>quota</code> 与额度刷新时间。</DocCard><DocCard title="请求明细返回">包含时间、模型、端点、状态码、总耗时、首 Token 时间、Token 明细与上游请求 ID；不返回错误正文或其他 Key 信息。</DocCard><DocCard title="参数范围"><code>days</code> 为 1 到保留期限，汇总默认 30 天、明细默认 7 天；<code>limit</code> 为 1–200，默认 50。</DocCard><DocCard title="安全边界">必须使用该业务 Key 的 <code>Authorization: Bearer</code>。Key 已被人工停用时返回 <code>401</code>；因额度超限而暂停的 Key 仍可查用量与额度。</DocCard></div>
          <p className="docs-note">未定价模型会出现在 <code>unpricedModels</code>，但不纳入金额合计，也不会以猜测金额触发额度拦截。</p>
        </DocSection>

        <DocSection id="quota" icon={Gauge} title="额度与自动刷新" subtitle={`额度状态包含在 GET ${USAGE_URL}/usage 的 quota 字段中；无需登录控制台`}>
          <div className="docs-card-grid"><DocCard title="日额度">按 <strong>Asia/Shanghai</strong> 结算，<strong>每天 00:00</strong> 自动刷新。</DocCard><DocCard title="周额度">按同一时区结算，<strong>每周一 00:00</strong> 自动刷新。</DocCard><DocCard title="总额度">从创建或上次手动重置起累计，<strong>不会自动刷新</strong>。</DocCard><DocCard title="超额行为">任一窗口超额时网关拒绝新调用；额度查询仍可读取当前花费、上限与下次刷新时间。</DocCard></div>
          <p className="docs-note">图片模型会将图像输入、图像输出等 token 写入网关的输入、输出、缓存字段，并据此结算。没有公开数字价卡的模型会标记为未定价，不会按猜测金额触发额度停用。</p>
        </DocSection>

        <DocSection id="clients" icon={Send} title="客户端配置" subtitle="大多数 OpenAI 兼容客户端仅需填写地址、Key 和从模型目录返回的模型名">
          <div className="docs-card-grid"><DocCard title="Cherry Studio / Chatbox / NextChat">服务商选择“OpenAI 兼容”，API 地址填 <code>{BASE_URL}</code>，填写已有 Key 后先刷新模型列表。</DocCard><DocCard title="环境变量"><code>OPENAI_BASE_URL={BASE_URL}</code><br /><code>OPENAI_API_KEY=&lt;你的 KEY&gt;</code></DocCard><DocCard title="流式请求">Chat 或 Responses 请求体添加 <code>"stream": true</code>，按 SSE 分块读取。</DocCard><DocCard title="无法登录控制台">不影响 API 使用。用 <a href="#models">GET /v1/models</a>、<a href="#usage">GET /v1/usage</a> 和 <a href="#usage">GET /v1/usage/requests</a> 完成模型、额度和请求自查。</DocCard></div>
        </DocSection>

        <footer className="docs-footer"><div><strong>Crosery API</strong><span>已有 Key 即可通过本页接口完成模型、调用、用量和额度自查。</span></div><a href="#models">从模型目录开始 <ChevronRight size={15} /></a></footer>
      </main>
    </div>
  </div>
}
