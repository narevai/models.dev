export function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000
}

export function formatPrice(p: number): string {
  if (p === 0) return '$0'
  return `$${p.toFixed(2)}`
}

export function priceArrow(oldVal: number, newVal: number): string {
  if (newVal > oldVal) return '↑'
  if (newVal < oldVal) return '↓'
  return '→'
}

export function pctChange(oldVal: number, newVal: number): string {
  if (oldVal === 0) return ''
  const pct = ((newVal - oldVal) / oldVal) * 100
  const sign = pct > 0 ? '+' : ''
  return ` _(${sign}${Math.round(pct)}%)_`
}

export function truncateList(lines: string[], maxItems = 20, sep = '\n'): string {
  if (lines.length <= maxItems) return lines.join(sep)
  return lines.slice(0, maxItems).join(sep) + `${sep}_…and ${lines.length - maxItems} more_`
}
