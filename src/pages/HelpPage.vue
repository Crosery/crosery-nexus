<script setup lang="ts">
import { ref } from 'vue'
import { TxCard } from '@talex-touch/tuffex/card'
import { TxButton } from '@talex-touch/tuffex/button'
import { TxTag } from '@talex-touch/tuffex/tag'
import { TxAlert } from '@talex-touch/tuffex/alert'
import type { ModelIndexData } from '../types'

defineProps<{
  modelIndex?: ModelIndexData | null
}>()

const BASE_URL = 'https://ai.crosery.com/v1'

const copiedIndex = ref<string | null>(null)

async function copyCode(text: string, id: string) {
  try {
    await navigator.clipboard.writeText(text)
    copiedIndex.value = id
    setTimeout(() => {
      if (copiedIndex.value === id) copiedIndex.value = null
    }, 1800)
  } catch {}
}

const TOC = [
  { id: 'quick-start', label: '1. 开始之前' },
  { id: 'crapi', label: '2. crapi 一键接入 (推荐)' },
  { id: 'openai', label: '3. OpenAI 聊天兼容' },
  { id: 'anthropic', label: '4. Anthropic 原生协议' },
  { id: 'responses', label: '5. Responses / Codex' },
  { id: 'images', label: '6. 图片生成与视觉' },
  { id: 'clients', label: '7. 常见 Agent 客户端' },
  { id: 'rtk', label: '8. 本机 RTK（可选，省 token）' },
]

const crapiInstallMac = `curl -fsSL https://cdn.jsdelivr.net/gh/crosery/crapi/install.sh | sh`
const crapiSetup = `# 自动检测并写入本机已安装客户端的所有配置
crapi setup

# 快捷切换默认模型
crapi use claude-opus-5-5

# 同步上游网关最新模型
crapi update`

const curlChat = `curl https://ai.crosery.com/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer <YOUR_API_KEY>" \\
  -d '{
    "model": "gpt-5.6-luna",
    "messages": [{"role": "user", "content": "你好！"}]
  }'`

const curlAnthropic = `curl https://ai.crosery.com/v1/messages \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: <YOUR_API_KEY>" \\
  -H "anthropic-version: 2023-06-01" \\
  -d '{
    "model": "claude-sonnet-4-6",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'`

const curlCodex = `curl https://ai.crosery.com/v1/responses \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer <YOUR_API_KEY>" \\
  -d '{
    "model": "gpt-5.6-sol",
    "input": [{"role": "user", "content": [{"type": "text", "text": "Solve this equation"}]}]
  }'`

const curlImage = `curl https://ai.crosery.com/v1/images/generations \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer <YOUR_API_KEY>" \\
  -d '{
    "model": "gpt-image-2.5",
    "prompt": "Cyberpunk city in mist, highly detailed",
    "size": "1024x1024"
  }'`

// 以下命令均按 rtk 0.50.0 的 `rtk init --help` 与实测核对过；全程作用于「本机客户端」，
// 与远端网关（中转站）https://ai.crosery.com/v1（推理端点）无关。
const rtkInstall = `curl -fsSL https://www.rtk-ai.app/install.sh | sh`

const rtkHooks = `# 按你实际用的客户端选一条（-g = 全局，作用于本机配置）
rtk init -g --codex                          # Codex CLI
rtk init -g --agent claude --auto-patch      # Claude Code
rtk init -g --agent cursor --auto-patch      # Cursor（会连带写 Claude 的钩子）
rtk init -g --gemini --auto-patch            # Gemini CLI
rtk init -g --copilot                        # GitHub Copilot
rtk init -g --agent trae --auto-patch        # 其它全局 agent：trae / droid / omp / pi / hermes / vibe

# 只能按项目初始化的 agent（在项目目录里执行，没有全局开关）
rtk init --agent windsurf    # 或 cline / kilocode / antigravity / kimi`

const rtkVerify = `# 看当前配置与节省情况：期待 summary.total_saved > 0
rtk gain --daily --format json
rtk init --show

# 卸载（必须带 agent 目标，且 -g 不能省）
rtk init -g --codex --uninstall
rtk init -g --agent claude --uninstall`
</script>

<template>
  <div class="page-stack help-page">
    <section class="page-head">
      <div class="page-head__text">
        <p class="eyebrow">DOCUMENTATION</p>
        <h1>接入帮助指南</h1>
        <p>提供多协议、跨语言客户端配置教程，每个代码示例均支持一键复制直接运行。</p>
      </div>
    </section>

    <div class="help-layout">
      <!-- 侧边导航目录 -->
      <aside class="toc-sidebar">
        <TxCard :padding="14" class="toc-card">
          <span class="toc-title">目录导航</span>
          <nav class="toc-nav">
            <a v-for="item in TOC" :key="item.id" :href="`#${item.id}`" class="toc-link">
              {{ item.label }}
            </a>
          </nav>
        </TxCard>
      </aside>

      <!-- 正文内容 -->
      <main class="help-content">
        <!-- 1. 开始之前 -->
        <TxCard id="quick-start" :padding="20" class="section-card">
          <div class="section-head">
            <TxTag label="01" color="#3346c8" size="sm" />
            <h2>开始之前</h2>
          </div>
          <p class="section-desc">使用同一把 API Key 即可调用 OpenAI、Anthropic、Responses 与图片生成等多协议端点。</p>
          <div class="facts-grid">
            <div class="fact-box">
              <span class="fact-label">OpenAI / 聚合 Base URL</span>
              <code class="fact-val mono">{{ BASE_URL }}</code>
            </div>
            <div class="fact-box">
              <span class="fact-label">Anthropic Base URL</span>
              <code class="fact-val mono">https://ai.crosery.com</code>
            </div>
            <div class="fact-box">
              <span class="fact-label">身份鉴权 Header</span>
              <code class="fact-val mono">Authorization: Bearer &lt;KEY&gt;</code>
            </div>
            <div class="fact-box">
              <span class="fact-label">模型目录获取</span>
              <code class="fact-val mono">GET {{ BASE_URL }}/models</code>
            </div>
          </div>
        </TxCard>

        <!-- 2. crapi 一键接入 -->
        <TxCard id="crapi" :padding="20" class="section-card">
          <div class="section-head">
            <TxTag label="02" color="#047857" size="sm" />
            <h2>crapi 一键接入 CLI (推荐)</h2>
          </div>
          <p class="section-desc"><strong>crapi</strong> 是专为 Crosery 渠道打造的一键配置命令行工具，自动识别并配置 Claude Code、Codex CLI、Cursor、Windsurf、Cline、Aider 等常见开发工具。</p>

          <div class="code-wrapper">
            <div class="code-header">
              <span>macOS / Linux 一键安装脚本</span>
              <TxButton size="sm" variant="ghost" @click="copyCode(crapiInstallMac, 'install-mac')">
                {{ copiedIndex === 'install-mac' ? '已复制' : '复制命令' }}
              </TxButton>
            </div>
            <pre class="code-block mono">{{ crapiInstallMac }}</pre>
          </div>

          <div class="code-wrapper mt-3">
            <div class="code-header">
              <span>常用命令</span>
              <TxButton size="sm" variant="ghost" @click="copyCode(crapiSetup, 'setup')">
                {{ copiedIndex === 'setup' ? '已复制' : '复制命令' }}
              </TxButton>
            </div>
            <pre class="code-block mono">{{ crapiSetup }}</pre>
          </div>
        </TxCard>

        <!-- 3. OpenAI 兼容调用 -->
        <TxCard id="openai" :padding="20" class="section-card">
          <div class="section-head">
            <TxTag label="03" color="#3346c8" size="sm" />
            <h2>OpenAI 聊天格式调用</h2>
          </div>
          <p class="section-desc">标准 OpenAI SDK 或兼容客户端可通过 <code>/v1/chat/completions</code> 发起调用。</p>
          <div class="code-wrapper">
            <div class="code-header">
              <span>cURL 请求示例</span>
              <TxButton size="sm" variant="ghost" @click="copyCode(curlChat, 'chat')">
                {{ copiedIndex === 'chat' ? '已复制' : '复制' }}
              </TxButton>
            </div>
            <pre class="code-block mono">{{ curlChat }}</pre>
          </div>
        </TxCard>

        <!-- 4. Anthropic 原生协议 -->
        <TxCard id="anthropic" :padding="20" class="section-card">
          <div class="section-head">
            <TxTag label="04" color="#a4491f" size="sm" />
            <h2>Anthropic 原生协议调用</h2>
          </div>
          <p class="section-desc">支持 Claude Code 与 Anthropic 官方 SDK 原生直通，包含提示词缓存与思考档位参数。</p>
          <div class="code-wrapper">
            <div class="code-header">
              <span>cURL 原生 Messages 接口示例</span>
              <TxButton size="sm" variant="ghost" @click="copyCode(curlAnthropic, 'anthropic')">
                {{ copiedIndex === 'anthropic' ? '已复制' : '复制' }}
              </TxButton>
            </div>
            <pre class="code-block mono">{{ curlAnthropic }}</pre>
          </div>
        </TxCard>

        <!-- 5. Responses / Codex -->
        <TxCard id="responses" :padding="20" class="section-card">
          <div class="section-head">
            <TxTag label="05" color="#047857" size="sm" />
            <h2>Responses / Codex 接口</h2>
          </div>
          <p class="section-desc">用于 Codex CLI 或 OpenAI 新版 Responses 协议调用的原生端点。</p>
          <div class="code-wrapper">
            <div class="code-header">
              <span>cURL /v1/responses 示例</span>
              <TxButton size="sm" variant="ghost" @click="copyCode(curlCodex, 'codex')">
                {{ copiedIndex === 'codex' ? '已复制' : '复制' }}
              </TxButton>
            </div>
            <pre class="code-block mono">{{ curlCodex }}</pre>
          </div>
        </TxCard>

        <!-- 6. 图片生成 -->
        <TxCard id="images" :padding="20" class="section-card">
          <div class="section-head">
            <TxTag label="06" color="#6d28d9" size="sm" />
            <h2>图片生成接口</h2>
          </div>
          <p class="section-desc">通过 <code>/v1/images/generations</code> 调用 gpt-image 系列视觉绘图模型。</p>
          <div class="code-wrapper">
            <div class="code-header">
              <span>cURL 生图示例</span>
              <TxButton size="sm" variant="ghost" @click="copyCode(curlImage, 'image')">
                {{ copiedIndex === 'image' ? '已复制' : '复制' }}
              </TxButton>
            </div>
            <pre class="code-block mono">{{ curlImage }}</pre>
          </div>
        </TxCard>

        <!-- 7. 常见客户端 -->
        <TxCard id="clients" :padding="20" class="section-card">
          <div class="section-head">
            <TxTag label="07" color="#b45309" size="sm" />
            <h2>常见客户端环境变量配置</h2>
          </div>
          <div class="client-grid">
            <div class="client-item">
              <strong>Claude Code</strong>
              <code>export ANTHROPIC_BASE_URL="https://ai.crosery.com"</code>
              <code>export ANTHROPIC_API_KEY="sk-..."</code>
            </div>
            <div class="client-item">
              <strong>Codex CLI</strong>
              <code>export OPENAI_BASE_URL="https://ai.crosery.com/v1"</code>
              <code>export OPENAI_API_KEY="sk-..."</code>
            </div>
            <div class="client-item">
              <strong>Cursor / Windsurf</strong>
              <span>在设置中选择 OpenAI 兼容提供商，填入 Base URL 与 API Key。</span>
            </div>
            <div class="client-item">
              <strong>Cline / Roo Code</strong>
              <span>Provider 选择 <code>OpenAI Compatible</code>，Base URL 填入 <code>https://ai.crosery.com/v1</code>。</span>
            </div>
          </div>
        </TxCard>
        <!-- 8. 本机 RTK -->
        <TxCard id="rtk" :padding="20" class="section-card">
          <div class="section-head">
            <TxTag label="08" color="#3346c8" size="sm" />
            <h2>本机 RTK（可选，省 token）</h2>
          </div>
          <p class="section-desc">
            RTK 把命令输出压缩后再喂给模型，省的是<strong>你本机客户端</strong>的 token。
            <code>{{ BASE_URL }}</code> 是推理端点，<strong>不承载配置下发</strong>；把 RTK 装在远端网关（中转站）上不会让你本机省 token。
            控制台侧栏的 <a href="/rtk">RTK 页面</a>可以查看/切换本机各客户端的挂载状态。
          </p>

          <div class="code-wrapper">
            <div class="code-header">
              <span>1. 安装（本机）</span>
              <TxButton size="sm" variant="ghost" @click="copyCode(rtkInstall, 'rtk-install')">
                {{ copiedIndex === 'rtk-install' ? '已复制' : '复制命令' }}
              </TxButton>
            </div>
            <pre class="code-block mono">{{ rtkInstall }}</pre>
          </div>

          <div class="code-wrapper mt-3">
            <div class="code-header">
              <span>2. 挂载 hook（本机，按客户端选一条）</span>
              <TxButton size="sm" variant="ghost" @click="copyCode(rtkHooks, 'rtk-hooks')">
                {{ copiedIndex === 'rtk-hooks' ? '已复制' : '复制命令' }}
              </TxButton>
            </div>
            <pre class="code-block mono">{{ rtkHooks }}</pre>
          </div>

          <TxAlert type="warning" title="--auto-patch 不能省" :closable="false">
            不带 <code>--auto-patch</code> 时，rtk 在非交互环境会对「是否写入 settings.json」默认选 N：
            命令退出码是 0，但 hook 根本没写进去，看起来「装了却不生效」。
          </TxAlert>

          <TxAlert type="info" title="写完 ≠ 立刻生效" :closable="false">
            挂载 hook 之后，<strong>正在运行的客户端不会热加载</strong>：先退出并重开该客户端，新的 hook 才会被读取；
            部分客户端（如需要确认 hook 信任的工具）首次触发时会再问一次，必须允许，否则命令输出仍不会被压缩。
            判断是否真的生效：新开一个会话跑 <code>rtk gain --daily</code>，看到 <code>total_saved</code> 增长即为生效。
            控制台「RTK 优化」页每 30 秒刷新一次状态，也可用来对照。
          </TxAlert>

          <div class="code-wrapper mt-3">
            <div class="code-header">
              <span>3. 验证与卸载（本机）</span>
              <TxButton size="sm" variant="ghost" @click="copyCode(rtkVerify, 'rtk-verify')">
                {{ copiedIndex === 'rtk-verify' ? '已复制' : '复制命令' }}
              </TxButton>
            </div>
            <pre class="code-block mono">{{ rtkVerify }}</pre>
          </div>
        </TxCard>
      </main>
    </div>
  </div>
</template>

<style scoped>
.help-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  width: 100%;
}
.page-head__text h1 {
  margin: 0;
  font-size: 24px;
  font-weight: 700;
  color: var(--tx-text-color-primary, #151b45);
}
.page-head__text p {
  margin: 4px 0 0;
  color: var(--tx-text-color-secondary, #535b85);
  font-size: 13.5px;
}
.eyebrow {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.05em;
  color: var(--tx-color-primary, #3346c8);
  margin-bottom: 2px;
}
.help-layout {
  display: grid;
  grid-template-columns: 200px 1fr;
  gap: 20px;
  align-items: start;
}
.toc-sidebar {
  position: sticky;
  top: 16px;
}
.toc-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.toc-title {
  font-size: 12px;
  font-weight: 700;
  color: var(--tx-text-color-secondary, #535b85);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.toc-nav {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.toc-link {
  font-size: 12.5px;
  color: var(--tx-text-color-secondary, #535b85);
  text-decoration: none;
  padding: 4px 6px;
  border-radius: 4px;
  transition: all 0.15s ease;
}
.toc-link:hover {
  background: var(--tx-fill-color, #eceff8);
  color: var(--tx-color-primary, #3346c8);
}
.help-content {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.section-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.section-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.section-head h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  color: var(--tx-text-color-primary, #151b45);
}
.section-desc {
  margin: 0;
  font-size: 13px;
  color: var(--tx-text-color-secondary, #535b85);
  line-height: 1.5;
}
.facts-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 10px;
  margin-top: 6px;
}
.fact-box {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px;
  background: var(--tx-fill-color, #eceff8);
  border-radius: 6px;
  border: 1px solid var(--tx-border-color, #d5daec);
}
.fact-label {
  font-size: 11px;
  color: var(--tx-text-color-secondary, #535b85);
}
.fact-val {
  font-size: 12px;
  color: var(--tx-text-color-primary, #151b45);
}
/* 代码块按 TUF 参考实现的做法：**浅色底 + 正文色**（geek_main/app/console/src/styles/layout.css:212-222 的 .pre）。
   原来写的是深色底 + 近白文字，但主题里 --tx-fill-color-darker 在浅色主题下是浅色（#e2e6f3），
   于是近白文字落在浅底上——实测对比度 1.18:1，命令几乎看不见（Lead 对比度审计发现）。 */
.code-wrapper {
  background: var(--tx-fill-color-lighter, #f8f9fd);
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid var(--tx-border-color, #d5daec);
}
.code-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 12px;
  background: var(--tx-fill-color-light, #f3f5fb);
  border-bottom: 1px solid var(--tx-border-color-lighter, #eaedf6);
  color: var(--tx-text-color-secondary, #535b85);
  font-size: 11.5px;
}
.code-block {
  margin: 0;
  padding: 12px;
  color: var(--tx-text-color-regular, #353d68);
  font-size: 12px;
  line-height: 1.5;
  overflow-x: auto;
}
.client-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 12px;
  margin-top: 6px;
}
.client-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px;
  background: var(--tx-fill-color, #eceff8);
  border-radius: 8px;
  border: 1px solid var(--tx-border-color, #d5daec);
  font-size: 12px;
}
.client-item code {
  padding: 4px 6px;
  background: #ffffff;
  border: 1px solid var(--tx-border-color, #d5daec);
  border-radius: 4px;
  word-break: break-all;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}
@media (max-width: 800px) {
  .help-layout {
    grid-template-columns: 1fr;
  }
  .toc-sidebar {
    display: none;
  }
}
</style>
