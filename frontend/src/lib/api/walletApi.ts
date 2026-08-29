import { apiClient } from './client'
import type {
  AccountSummary,
  BillSplit,
  BillSplitsResponse,
  MoneyRequest,
  RequestsResponse,
  TransactionsPage,
  UserResult,
} from './walletTypes'

export const walletApi = {
  async dashboard() {
    return (await apiClient.get<AccountSummary>('/accounts/me/summary')).data
  },
  async searchUsers(query: string) {
    return (await apiClient.get<UserResult[]>('/users/search', { params: { q: query } })).data
  },
  async sendMoney(input: { recipientId: string; amountPoisha: string; pin: string; idempotencyKey: string }) {
    const { idempotencyKey, ...body } = input
    return (await apiClient.post<{ transaction: AccountSummary['recentActivity'][number]; balancePoisha: string }>(
      '/transfers', body, { headers: { 'Idempotency-Key': idempotencyKey } },
    )).data
  },
  async requests() {
    return (await apiClient.get<RequestsResponse>('/money-requests')).data
  },
  async createRequest(input: { requesteeId: string; amountPoisha: string; note?: string; idempotencyKey?: string }) {
    const { idempotencyKey, ...body } = input
    return (await apiClient.post<{ id: string; status: string }>(
      '/money-requests', body, idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : undefined
    )).data
  },
  async updateRequest(id: string, action: 'accept' | 'reject', pin?: string, idempotencyKey?: string) {
    return (await apiClient.post<{ request: MoneyRequest; balancePoisha?: string }>(
      `/money-requests/${id}/${action}`,
      pin ? { pin } : {},
      idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : undefined,
    )).data
  },
  async transactions(params: { cursor?: string; direction?: string; status?: string; from?: string; to?: string }) {
    return (await apiClient.get<TransactionsPage>('/transactions', { params: { ...params, limit: 20 } })).data
  },
  async billSplits() {
    return (await apiClient.get<BillSplitsResponse>('/bill-splits')).data
  },
  async createBillSplit(input: {
    totalAmountPoisha: string
    description?: string
    shares: { payerId: string; amountPoisha: string }[]
  }) {
    return (await apiClient.post<{ id: string; reference: string; status: string }>('/bill-splits', input)).data
  },
  async payBillSplitShare(splitId: string, pin: string) {
    return (
      await apiClient.post<{ reference: string; balancePoisha: string; splitSettled: boolean }>(
        `/bill-splits/${splitId}/pay`,
        { pin },
      )
    ).data
  },
  async billSplitDetail(splitId: string) {
    return (await apiClient.get<BillSplit>(`/bill-splits/${splitId}`)).data
  },
}
