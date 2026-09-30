import { createApp } from 'vue'
import '@talex-touch/tuffex/style.css'
import 'virtual:uno.css'
import './styles/theme.css'
import './styles/layout.css'
import App from './App.vue'
import { router } from './router'

createApp(App).use(router).mount('#app')
