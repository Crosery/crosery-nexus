import { createApp } from 'vue'
// Load order is part of the theme contract (DESIGN.md §2.4): tuffex tokens → uno → our tokens → bridge → base → layout → motion.
// Component stylesheets arrive per chunk through tuffexOnDemandStylePlugin (vite.config.ts).
import '@talex-touch/tuffex/base.css'
import 'virtual:uno.css'
import './styles/tokens.css'
import './styles/tuffex-bridge.css'
import './styles/base.css'
import './styles/layout.css'
import './styles/motion.css'
import { initTheme } from './lib/theme'
import { initMotion } from './lib/motion'
import { initPrivacy } from './lib/privacy'
import App from './App.vue'
import { router } from './router'

initMotion()
initTheme()
initPrivacy()

createApp(App).use(router).mount('#app')
