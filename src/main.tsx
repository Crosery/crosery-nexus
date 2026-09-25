import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './request-details.css'
import App from './App.tsx'

const root = document.getElementById('root')
if (!root) throw new Error('缺少 #root 容器')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
