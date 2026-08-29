import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import { router } from './router'
import { AuthProvider } from './lib/auth/AuthProvider'
import './styles/index.css'

const root = document.getElementById('root')

if (!root) {
  throw new Error('Application root element was not found.')
}

createRoot(root).render(
  <StrictMode>
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  </StrictMode>,
)
