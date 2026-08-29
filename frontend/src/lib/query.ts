import { QueryClient } from '@tanstack/react-query'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: true },
    mutations: { retry: false },
  },
})

export const queryKeys = {
  dashboard: ['dashboard'] as const,
  requests: ['money-requests'] as const,
  transactions: (filters: object) => ['transactions', filters] as const,
  billSplits: ['bill-splits'] as const,
}
