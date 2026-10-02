import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'
import { expandStyleClosure, tuffexOnDemandStylePlugin } from '@talex-touch/tuffex/vite'

const TX_OVERRIDES_DIR = resolve(import.meta.dirname, 'src/styles/tx')
const TUFFEX_IMPORT_RE = /\bfrom\s+['"]@talex-touch\/tuffex\/([a-z0-9-]+)['"]|import\(\s*['"]@talex-touch\/tuffex\/([a-z0-9-]+)['"]\s*\)/g

/**
 * Telemetry Paper restyles for tuffex components (src/styles/tx/<component>.css) ride along with the
 * component the same way tuffexOnDemandStylePlugin ships the component's own CSS: a module that imports
 * `@talex-touch/tuffex/<name>` also imports the override for every component in <name>'s style closure.
 * Overrides are `html:root`-prefixed, so their order relative to tuffex's stylesheet does not matter.
 */
function tuffexThemeOverrides(): Plugin {
  let styleDeps: Record<string, string[]> = {}
  return {
    name: 'console-tuffex-theme-overrides',
    enforce: 'post',
    buildStart() {
      const pkg = createRequire(import.meta.url).resolve('@talex-touch/tuffex/package.json')
      styleDeps = JSON.parse(readFileSync(resolve(dirname(pkg), 'dist/es/style-deps.json'), 'utf8'))
    },
    transform(code, id) {
      if (id.includes('/node_modules/') || !/\.(?:[cm]?[jt]sx?|vue)(?:$|\?)/.test(id) || !code.includes('@talex-touch/tuffex/')) return null
      const names = new Set<string>()
      for (const match of code.matchAll(TUFFEX_IMPORT_RE)) {
        const name = match[1] ?? match[2]
        if (name && name !== 'utils' && name !== 'vite') names.add(name)
      }
      const imports = expandStyleClosure([...names], styleDeps)
        .map((name) => resolve(TX_OVERRIDES_DIR, `${name}.css`))
        .filter((file) => existsSync(file))
        .map((file) => `import ${JSON.stringify(file)};`)
      return imports.length ? { code: `${imports.join('\n')}\n${code}`, map: null } : null
    },
  }
}

export default defineConfig({
  plugins: [
    vue(),
    UnoCSS(),
    // Each `@talex-touch/tuffex/<name>` import pulls in that component's stylesheet closure (style-deps.json)
    // in the chunk that uses it, instead of the 621 KB full style.css in the entry.
    tuffexOnDemandStylePlugin(),
    tuffexThemeOverrides(),
  ],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8791',
        changeOrigin: true,
      },
    },
  },
  build: {
    manifest: true,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      input: {
        console: resolve(import.meta.dirname, 'index.html'),
        docs: resolve(import.meta.dirname, 'docs.html'),
      },
    },
  },
})
