import { createBrowserRouter } from 'react-router-dom'
import { AppShell } from './components/layout/AppShell'
import { ShellIndex } from './components/layout/ShellIndex'
import { RouteError } from './components/layout/RouteError'

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    errorElement: <RouteError />,
    children: [{ index: true, element: <ShellIndex /> }],
  },
])
