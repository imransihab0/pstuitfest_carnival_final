import { useEffect, useRef, type PropsWithChildren } from 'react'
import { io } from 'socket.io-client'
import type { AccountSummary, Transaction } from '../api/walletTypes'
import { getAccessToken } from '../auth/accessToken'
import { useAuth } from '../auth/useAuth'
import { queryClient, queryKeys } from '../query'

type TransferNotification = {
  balancePoisha: string
  transaction: Transaction
}

function socketUrl(): string {
  if (import.meta.env.VITE_SOCKET_URL) return import.meta.env.VITE_SOCKET_URL

  const apiUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api/v1'
  return new URL(apiUrl, window.location.origin).origin
}

function isTransaction(value: unknown): value is Transaction {
  if (!value || typeof value !== 'object') return false
  const transaction = value as Partial<Transaction>

  return (
    typeof transaction.id === 'string' &&
    typeof transaction.reference === 'string' &&
    typeof transaction.amountPoisha === 'string' &&
    (transaction.direction === 'CREDIT' || transaction.direction === 'DEBIT') &&
    typeof transaction.counterpartyName === 'string' &&
    (transaction.status === 'SUCCESS' || transaction.status === 'PENDING' || transaction.status === 'FAILED') &&
    typeof transaction.createdAt === 'string'
  )
}

function isTransferNotification(value: unknown): value is TransferNotification {
  if (!value || typeof value !== 'object') return false
  const notification = value as Partial<TransferNotification>

  return /^\d+$/.test(notification.balancePoisha ?? '') && isTransaction(notification.transaction)
}

export function RealtimeProvider({ children }: PropsWithChildren) {
  const { status } = useAuth()
  const hasConnected = useRef(false)

  useEffect(() => {
    if (status !== 'authenticated') {
      hasConnected.current = false
      return
    }

    const socket = io(socketUrl(), {
      transports: ['websocket', 'polling'],
      auth: (done) => done({ token: getAccessToken() }),
    })

    const reconcileAfterReconnect = () => {
      if (hasConnected.current) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard })
        void queryClient.invalidateQueries({ queryKey: ['transactions'] })
      }
      hasConnected.current = true
    }

    const applyTransfer = (payload: unknown) => {
      if (!isTransferNotification(payload)) {
        // Unknown socket data must never corrupt money in the REST-owned cache.
        void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard })
        return
      }

      let updated = false
      queryClient.setQueryData<AccountSummary>(queryKeys.dashboard, (current) => {
        if (!current) return current
        updated = true

        const recentActivity = [
          payload.transaction,
          ...current.recentActivity.filter(
            (item) => item.id !== payload.transaction.id && item.reference !== payload.transaction.reference,
          ),
        ]

        return {
          balancePoisha: payload.balancePoisha,
          recentActivity: recentActivity.slice(0, 8),
        }
      })

      if (!updated) void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard })
      void queryClient.invalidateQueries({ queryKey: ['transactions'] })
    }

    socket.on('connect', reconcileAfterReconnect)
    socket.on('transfer:received', applyTransfer)

    return () => {
      socket.off('connect', reconcileAfterReconnect)
      socket.off('transfer:received', applyTransfer)
      socket.disconnect()
    }
  }, [status])

  return children
}
