const MONEY_PATTERN = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/

export function takaToPoisha(value: string): string | null {
  const normalized = value.trim().replace(/,/g, '')
  const match = MONEY_PATTERN.exec(normalized)
  if (!match) return null

  const poisha = BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0') || '0')
  return poisha > 0n && poisha <= 9_223_372_036_854_775_807n ? poisha.toString() : null
}

export function formatPoisha(value: string | bigint): string {
  const poisha = typeof value === 'bigint' ? value : BigInt(value)
  const sign = poisha < 0n ? '−' : ''
  const absolute = poisha < 0n ? -poisha : poisha
  const taka = absolute / 100n
  const fraction = (absolute % 100n).toString().padStart(2, '0')
  return `${sign}৳${taka.toLocaleString('en-US')}.${fraction}`
}
