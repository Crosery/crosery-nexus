import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [
    vue(),
    react({
      include: /docs.*\.(jsx|tsx)$/,
    }),
    UnoCSS(),
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
