import { resolve } from 'node:path'

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    manifest: true,
    rollupOptions: {
      input: {
        console: resolve(import.meta.dirname, 'index.html'),
        docs: resolve(import.meta.dirname, 'docs.html'),
      },
    },
  },
})
