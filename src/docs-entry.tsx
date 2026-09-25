import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import DocsApp from './docs.tsx'

const root = document.getElementById('root')
if (!root) throw new Error('缺少 #root 容器')

createRoot(root).render(
  <StrictMode>
    <DocsApp />
  </StrictMode>,
)
