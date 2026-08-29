import { createBrowserRouter } from 'react-router-dom'
import { AppShell } from './components/layout/AppShell'
import { ShellIndex } from './components/layout/ShellIndex'
import { RouteError } from './components/layout/RouteError'
import { AuthLayout } from './components/layout/AuthLayout'
import { GuestRoute } from './components/auth/GuestRoute'
import { ProtectedRoute } from './components/auth/ProtectedRoute'
import { LoginScreen } from './screens/auth/LoginScreen'
import { RegisterScreen } from './screens/auth/RegisterScreen'

export const router = createBrowserRouter([
  {
    path: '/',
    errorElement: <RouteError />,
    children: [
      {
        element: <GuestRoute />,
        children: [
          {
            element: <AuthLayout />,
            children: [
              { path: 'login', element: <LoginScreen /> },
              { path: 'register', element: <RegisterScreen /> },
            ],
          },
        ],
      },
      {
        element: <ProtectedRoute />,
        children: [
          {
            element: <AppShell />,
            children: [{ index: true, element: <ShellIndex /> }],
          },
        ],
      },
    ],
  },
])
