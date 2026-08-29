import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import { router } from './router'
import { AuthProvider } from './lib/auth/AuthProvider'
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient } from './lib/query'
import './styles/index.css'

const root = document.getElementById('root')

if (!root) {
  throw new Error('Application root element was not found.')
}

createRoot(root).render(
  <StrictMode>
    <AuthProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </AuthProvider>
  </StrictMode>,
)
