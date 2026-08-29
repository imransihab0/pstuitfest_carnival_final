import { createBrowserRouter } from 'react-router-dom'
import { AppShell } from './components/layout/AppShell'
import { RouteError } from './components/layout/RouteError'
import { AuthLayout } from './components/layout/AuthLayout'
import { GuestRoute } from './components/auth/GuestRoute'
import { ProtectedRoute } from './components/auth/ProtectedRoute'
import { LoginScreen } from './screens/auth/LoginScreen'
import { RegisterScreen } from './screens/auth/RegisterScreen'
import { DashboardScreen } from './screens/DashboardScreen'
import { SendMoneyScreen } from './screens/SendMoneyScreen'
import { RequestsScreen } from './screens/RequestsScreen'
import { RequestMoneyScreen } from './screens/RequestMoneyScreen'
import { HistoryScreen } from './screens/HistoryScreen'
import { SplitsScreen } from './screens/SplitsScreen'

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
            children: [
              { index: true, element: <DashboardScreen /> },
              { path: 'send', element: <SendMoneyScreen /> },
              { path: 'requests', element: <RequestsScreen /> },
              { path: 'splits', element: <SplitsScreen /> },
              { path: 'requests/new', element: <RequestMoneyScreen /> },
              { path: 'history', element: <HistoryScreen /> },
            ],
          },
        ],
      },
    ],
  },
])
