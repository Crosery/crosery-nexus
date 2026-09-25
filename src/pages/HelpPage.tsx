import { Activity, Boxes, Check, ChevronRight, Copy, Database, Gauge, Image as ImageIcon, KeyRound, MessageSquare, Terminal } from 'lucide-react'
import { useState } from 'react'
import type { ModelIndexData } from '../types'

const BASE_URL = 'https://ai.crosery.com/v1'
const HELP_API = 'https://console.ai.crosery.com/api'

type HelpSectionId = 'quick-start' | 'openai' | 'anthropic' | 'responses' | 'images' | 'quota' | 'usage' | 'clients' | 'models'

const TOC: Array<{ id: HelpSectionId; label: string }> = [
  { id: 'quick-start', label: '开始之前' },
  { id: 'openai', label: 'OpenAI 聊天' },
  { id: 'anthropic', label: 'Anthropic 原生' },
  { id: 'responses', label: 'Responses / Codex' },
  { id: 'images', label: '图片生成' },
  { id: 'quota', label: '额度与刷新' },
  { id: 'usage', label: '用量查询' },
  { id: 'clients', label: '常用客户端' },
  { id: 'models', label: '可用模型' },
]

function CodeBlock({ code, label }: { code: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return <div className="code-block">
    {label && <div className="code-label">{label}</div>}
    <button
      type="button"
      className="code-copy"
      onClick={async () => {
        await navigator.clipboard.writeText(code)
        setCopied(true)
        setTimeout(() => setCopied(false), 1600)
      }}
    >{copied ? <Check size={13} /> : <Copy size={13} />}{copied ? '已复制' : '复制'}</button>
    <pre><code>{code}</code></pre>
  </div>
}

function Section({ id, icon: Icon, title, subtitle, children }: { id: HelpSectionId; icon: typeof Terminal; title: string; subtitle: string; children: React.ReactNode }) {
  return <article id={id} className="help-section">
    <header className="help-section-heading">
      <div className="help-icon"><Icon size={17} /></div>
      <div><h2>{title}</h2><p>{subtitle}</p></div>
    </header>
    <div className="help-section-body">{children}</div>
  </article>
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="help-fact"><span>{label}</span><strong>{children}</strong></div>
}

export function HelpPage({ modelIndex }: { modelIndex: ModelIndexData | null }) {
  const models = (modelIndex?.models || []).map((entry) => entry.id)
  const chatModel = models.find((model) => model.startsWith('gpt-') && !model.includes('image')) || 'gpt-5.4-mini'
  const claudeModel = models.find((model) => model.startsWith('claude-')) || 'claude-sonnet-5'
  const imageModel = models.find((model) => model.includes('image')) || 'gpt-image-2'

  return <div className="help-page">
    <section className="page-heading help-page-heading">
      <div>
        <p className="eyebrow">DOCUMENTATION</p>
        <h1>接入帮助</h1>
        <p>从创建 Key 到文本、图片调用与用量查询。每个示例都可以直接复制使用。</p>
      </div>
      <a className="help-heading-link" href="#quick-start"><ChevronRight size={15} />从开始之前阅读</a>
    </section>

    <div className="help-layout">
      <nav className="help-toc" aria-label="帮助目录">
        <p>目录</p>
        {TOC.map((item) => <a key={item.id} href={`#${item.id}`}>{item.label}<ChevronRight size={13} /></a>)}
      </nav>

      <main className="help-document scroll-area">
        <Section id="quick-start" icon={KeyRound} title="开始之前" subtitle="使用同一把 API Key 调用 OpenAI、Anthropic 和图片接口">
          <div className="help-facts">
            <Fact label="OpenAI Base URL">{BASE_URL}</Fact>
            <Fact label="Anthropic Base URL">https://ai.crosery.com</Fact>
            <Fact label="鉴权">Authorization: Bearer &lt;KEY&gt;</Fact>
            <Fact label="模型目录">GET {BASE_URL}/models</Fact>
          </div>
          <p className="help-note">在「API Key」页创建密钥后复制。Anthropic 请求也支持 <code>x-api-key: &lt;KEY&gt;</code>；无效 Key 返回 <code>401</code>，没有模型权限返回 <code>403 model_not_allowed</code>。</p>
        </Section>

        <Section id="openai" icon={MessageSquare} title="OpenAI 聊天接口" subtitle="/v1/chat/completions，绝大多数 OpenAI 兼容客户端都使用这个接口">
          <CodeBlock label="curl" code={`curl ${BASE_URL}/chat/completions \\
  -H "Authorization: Bearer $CROSERY_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${chatModel}",
    "messages": [{"role": "user", "content": "你好"}]
  }'`} />
          <CodeBlock label="Python · openai SDK" code={`from openai import OpenAI

client = OpenAI(api_key="<你的 KEY>", base_url="${BASE_URL}")
response = client.chat.completions.create(
    model="${chatModel}",
    messages=[{"role": "user", "content": "你好"}],
)
print(response.choices[0].message.content)`} />
          <p className="help-note">在请求体加入 <code>"stream": true</code> 可启用标准 SSE 流式响应。Claude 模型也可以使用这个接口，只需把 <code>model</code> 换为 <code>{claudeModel}</code>。</p>
        </Section>

        <Section id="anthropic" icon={Terminal} title="Anthropic 原生接口" subtitle="/v1/messages，适用于 Anthropic SDK 与 Claude Code">
          <CodeBlock label="curl" code={`curl ${BASE_URL}/messages \\
  -H "x-api-key: $CROSERY_API_KEY" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${claudeModel}",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "你好"}]
  }'`} />
          <CodeBlock label="Claude Code" code={`export ANTHROPIC_BASE_URL="https://ai.crosery.com"
export ANTHROPIC_AUTH_TOKEN="<你的 KEY>"
claude`} />
          <p className="help-note"><code>max_tokens</code> 为必填字段。Claude Code 的 Base URL 不带 <code>/v1</code>，由客户端自动补齐。</p>
        </Section>

        <Section id="responses" icon={Boxes} title="Responses / Codex 接口" subtitle="/v1/responses，适用于 Codex CLI 与新版 OpenAI SDK">
          <CodeBlock label="curl" code={`curl ${BASE_URL}/responses \\
  -H "Authorization: Bearer $CROSERY_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "${chatModel}", "input": "你好"}'`} />
          <CodeBlock label="~/.codex/config.toml" code={`model = "${chatModel}"
model_provider = "crosery"

[model_providers.crosery]
name = "Crosery"
base_url = "https://ai.crosery.com/v1"
env_key = "CROSERY_API_KEY"
wire_api = "responses"`} />
          <p className="help-note">Responses 使用 <code>input</code>，不是 <code>messages</code>。普通聊天客户端优先使用 chat/completions。</p>
        </Section>

        <Section id="images" icon={ImageIcon} title="图片生成" subtitle="/v1/images/generations，生成结果以 base64 PNG 返回">
          <CodeBlock label="curl" code={`curl ${BASE_URL}/images/generations \\
  -H "Authorization: Bearer $CROSERY_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${imageModel}",
    "prompt": "一只在屋顶上的橘猫，水彩风格",
    "n": 1,
    "size": "1024x1024"
  }'`} />
          <CodeBlock label="Python · 保存 PNG" code={`import base64
from openai import OpenAI

client = OpenAI(api_key="<你的 KEY>", base_url="${BASE_URL}")
result = client.images.generate(
    model="${imageModel}",
    prompt="一只在屋顶上的橘猫，水彩风格",
    size="1024x1024",
)
open("output.png", "wb").write(base64.b64decode(result.data[0].b64_json))`} />
          <div className="help-tip-grid">
            <div><strong>先查模型</strong><p>执行 <code>GET /v1/models</code>，只用列表中有 <code>image</code> 的模型。</p></div>
            <div><strong>读取结果</strong><p>读取 <code>data[0].b64_json</code> 并 base64 解码；响应没有 <code>url</code>。</p></div>
            <div><strong>开始参数</strong><p>从 <code>n: 1</code>、<code>1024x1024</code> 开始，再按模型支持范围调整。</p></div>
            <div><strong>超时重试</strong><p>客户端超时至少设为 120 秒；超时后先查用量，避免重复生成。</p></div>
          </div>
        </Section>

        <Section id="quota" icon={Gauge} title="额度与刷新时间" subtitle="在「API Key」页设置总、日、周额度；任一窗口超额都会让 Key 停用">
          <div className="help-tip-grid">
            <div><strong>日额度</strong><p>按服务器时区 <strong>Asia/Shanghai</strong> 结算，<strong>每天 00:00</strong> 自动刷新。</p></div>
            <div><strong>周额度</strong><p>按同一时区结算，<strong>每周一 00:00</strong> 自动刷新。</p></div>
            <div><strong>总额度</strong><p>从创建或上次手动重置开始累计，<strong>不会自动刷新</strong>。</p></div>
            <div><strong>实际拦截</strong><p>超额 Key 会从 CPA 可用 Key 列表移除；日/周刷新后只恢复因超额被停用的 Key。</p></div>
          </div>
          <p className="help-note">文本模型按输入、输出、缓存命中三段单价估算。没有可靠公开单价的模型不会被猜价，也不会触发额度停用。</p>
        </Section>

        <Section id="usage" icon={Activity} title="用量查询接口" subtitle="管理端接口，须已登录控制台并携带会话 Cookie，不接受普通业务 API Key">
          <CodeBlock label="按 Key 查询最近 7 天" code={`curl "${HELP_API}/usage-breakdown?days=7&keyId=<keys[].id>" \\
  -b "crosery_console_session=<登录后的 Cookie>"`} />
          <CodeBlock label="查询总览、每日和渠道用量" code={`curl "${HELP_API}/usage-overview?days=30&keyId=<keys[].id>" \\
  -b "crosery_console_session=<登录后的 Cookie>"`} />
          <div className="help-tip-grid">
            <div><strong>GET /api/bootstrap</strong><p>返回 <code>keys[].id</code>。省略 <code>keyId</code> 时统计全部 Key。</p></div>
            <div><strong>GET /api/usage-breakdown</strong><p>返回逐模型请求数、输入/输出/缓存 token、单价、分项花费和未定价模型。</p></div>
            <div><strong>GET /api/usage-overview</strong><p>返回汇总、按日明细、渠道分布、成本估算和未定价模型。</p></div>
            <div><strong>查询范围</strong><p><code>days</code> 最小为 1，最大为控制台设置的详细用量保留天数。</p></div>
          </div>
        </Section>

        <Section id="clients" icon={Terminal} title="常用客户端" subtitle="OpenAI 兼容客户端只需配置 Base URL、API Key 和模型名">
          <div className="help-tip-grid">
            <div><strong>Cherry Studio / Chatbox / NextChat</strong><p>服务商选择“OpenAI 兼容”，API 地址填 <code>{BASE_URL}</code>，然后填写控制台创建的 Key。</p></div>
            <div><strong>环境变量</strong><p><code>OPENAI_BASE_URL={BASE_URL}</code><br /><code>OPENAI_API_KEY=&lt;你的 KEY&gt;</code></p></div>
            <div><strong>流式响应</strong><p>在 chat/completions 或 responses 的请求体添加 <code>"stream": true</code>。</p></div>
            <div><strong>模型权限</strong><p>模型列表只显示当前 Key 有权限调用的模型；无权限请求返回 <code>403 model_not_allowed</code>。</p></div>
          </div>
        </Section>

        <Section id="models" icon={Database} title="可用模型与计费口径" subtitle={`当前网关目录中有 ${models.length} 个模型；以「模型总览」页的实时状态为准`}>
          <CodeBlock label="列出当前 Key 可用的模型" code={`curl ${BASE_URL}/models \\
  -H "Authorization: Bearer $CROSERY_API_KEY"`} />
          <p className="help-note">模型总览同时显示固定单价与所选周期的实际用量。模型价格单位为 USD / 1M Token，区分新输入、输出和缓存；图片模型按网关返回的图像 token 口径计价。</p>
          <div className="help-models">{models.map((model) => <span key={model} className="model-pill">{model}</span>)}</div>
        </Section>
      </main>
    </div>
  </div>
}
