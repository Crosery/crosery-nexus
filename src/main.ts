import { createApp } from 'vue'
// Theme CSS is Telemetry-only; minimal keeps semantic layout/reset and native Tuffex visuals.
// Component stylesheets arrive per chunk through tuffexOnDemandStylePlugin (vite.config.ts).
import '@talex-touch/tuffex/base.css'
import 'virtual:uno.css'
import './styles/tokens.css'
import './styles/tuffex-bridge.css'
import './styles/base.css'
import './styles/layout.css'
import './styles/motion.css'
import { initSkin, loadSkinStyles } from './lib/skin'
import { initTheme } from './lib/theme'
import { initMotion } from './lib/motion'
import { initTitle } from './lib/title'
import { initPrivacy } from './lib/privacy'
import App from './App.vue'
import { router } from './router'

initSkin()
initMotion()
initTheme()
initTitle()
initPrivacy()

void loadSkinStyles().then(() => createApp(App).use(router).mount('#app'))
