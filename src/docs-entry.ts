import { createApp } from 'vue'
// UnoCSS 运行时样式：图标（`i-carbon-*`）与工具类都由它生成。
// React 版本用 lucide 的 SVG，不需要这一行；迁移成 UnoCSS 图标后必须显式引入，
// 否则图标类没有任何 CSS（实测：section 头只剩一个空方块）。
import 'virtual:uno.css'
import './index.css'
import DocsPage from './pages/DocsPage.vue'

/**
 * `/docs` 独立入口（原 `src/docs-entry.tsx` 的 Vue 迁移，task-43）。
 *
 * 仍然是**独立页面**：`docs.html` → 本文件 → 挂载到 `#root`，不带控制台侧栏、由
 * `window.open('/docs', '_blank')` 新标签打开（UX 不变）。迁移后这里不再需要
 * React/ReactDOM，`StrictMode` 没有对应物也不需要（Vue 不做双渲染）。
 */
const root = document.getElementById('root')
if (!root) throw new Error('缺少 #root 容器')

createApp(DocsPage).mount(root)
