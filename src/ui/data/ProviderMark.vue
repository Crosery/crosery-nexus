<script setup lang="ts">
import { computed } from 'vue'

/**
 * Provider logo as a CSS mask filled with --ink (so it follows the theme), inside a 1px ink square with a notch.
 * Logos live in /public/logos (lobe-icons silhouettes). Unknown providers — and GitHub Copilot, which has no
 * mark yet — fall back to a two-letter monogram.
 */
const props = withDefaults(defineProps<{ provider: string; size?: number; label?: string }>(), { size: 22, label: undefined })

const LOGOS: Record<string, string> = {
  claude: 'claude', anthropic: 'anthropic',
  codex: 'codex', openai: 'openai', chatgpt: 'openai', gpt: 'openai',
  gemini: 'gemini', 'gemini-cli': 'geminicli', geminicli: 'geminicli', google: 'gemini',
  antigravity: 'antigravity',
  kimi: 'kimi', moonshot: 'moonshot',
  xai: 'xai', grok: 'xai',
  deepseek: 'deepseek', qwen: 'qwen', zhipu: 'zhipu', glm: 'zhipu', minimax: 'minimax', openrouter: 'openrouter',
}
const MONOGRAMS: Record<string, string> = { copilot: 'GH', 'github-copilot': 'GH', github: 'GH' }

const key = computed(() => props.provider.trim().toLowerCase().replace(/[\s_]+/g, '-'))
const logo = computed(() => LOGOS[key.value] ?? LOGOS[key.value.split('-')[0]])
const monogram = computed(() => MONOGRAMS[key.value] ?? props.provider.replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase())
const style = computed(() => ({
  '--pm': `${props.size}px`,
  ...(logo.value ? { '--logo': `url(/logos/${logo.value}.svg)` } : {}),
}))
</script>

<template>
  <span class="ui-pm" :class="{ 'has-logo': logo }" :style="style" :role="label ? 'img' : undefined" :aria-label="label" :aria-hidden="label ? undefined : 'true'">
    <i v-if="logo" class="ui-pm__logo" />
    <span v-else class="ui-pm__mono">{{ monogram }}</span>
  </span>
</template>

<style>
.ui-pm {
  position: relative; width: var(--pm); height: var(--pm); flex: none; display: inline-grid; place-items: center;
  border: 1px solid var(--ink); border-radius: var(--r-1); color: var(--ink);
}
.ui-pm::after { content: ""; position: absolute; right: -1px; bottom: -1px; width: calc(var(--pm) / 4.4); height: calc(var(--pm) / 4.4); background: var(--ink); }
.ui-pm__logo {
  width: calc(var(--pm) - 9px); height: calc(var(--pm) - 9px); background: var(--ink);
  -webkit-mask: var(--logo) center / contain no-repeat; mask: var(--logo) center / contain no-repeat;
}
.ui-pm__mono { font-family: var(--font-mono); font-size: calc(var(--pm) * .43); font-weight: 700; letter-spacing: .02em; line-height: 1; }
</style>
