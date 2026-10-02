import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, presetIcons } from 'unocss'
import { RUNTIME_ICON_CLASSES } from './src/lib/icons'

const runtimeIcons = fileURLToPath(new URL('./src/lib/icons.ts', import.meta.url))

/*
 * Tuffex renders `<i class="i-carbon-…">` inside its own components. Every generated icon is an inline SVG in the
 * ENTRY stylesheet, so:
 *  - build: the extraction pipeline also scans the tuffex dist modules that are actually in the module graph,
 *    so only icons of components the console imports are emitted;
 *  - dev: tuffex is pre-bundled by optimizeDeps (never transformed), so its icon classes are safelisted, minus the
 *    families the console never renders.
 */
const IS_BUILD = process.argv.includes('build')
const TUFFEX_FAMILIES_NOT_RENDERED = new Set([
  'markdown-editor', 'agents', 'agent-screen', 'agent-trace', 'image-uploader', 'file-uploader', 'flip-overlay', 'transfer',
])
const ICON_CLASS = /\bi-carbon-[a-z0-9-]+/g

function tuffexIconsInUse(): string[] {
  let root: string
  try {
    root = join(dirname(createRequire(import.meta.url).resolve('@talex-touch/tuffex')), '..', 'es')
  } catch {
    return []
  }
  const found = new Set<string>()
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.js')) for (const match of readFileSync(full, 'utf8').matchAll(ICON_CLASS)) found.add(match[0])
    }
  }
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && !TUFFEX_FAMILIES_NOT_RENDERED.has(entry.name)) walk(join(root, entry.name))
    }
  } catch {
    return []
  }
  return [...found].sort()
}

export default defineConfig({
  presets: [
    presetIcons({
      scale: 1.2,
      extraProperties: {
        display: 'inline-block',
        'vertical-align': '-0.2em',
        'flex-shrink': '0',
      },
    }),
  ],

  safelist: IS_BUILD ? [...RUNTIME_ICON_CLASSES] : [...new Set([...tuffexIconsInUse(), ...RUNTIME_ICON_CLASSES])],

  content: {
    pipeline: {
      include: [
        /\.(vue|html|tsx|jsx)($|\?)/,
        /src\/.*\.ts($|\?)/,
        /@talex-touch\/tuffex\/dist\/es\/.*\.js($|\?)/,
      ],
    },
  },

  configDeps: [runtimeIcons],
})
