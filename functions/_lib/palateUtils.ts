export function normalizePalates(
  palates: unknown,
): string[] {
  if (!palates) return []

  if (Array.isArray(palates)) {
    return palates
      .map((p) => {
        if (typeof p === 'string') return p.trim().toLowerCase()
        if (typeof p === 'object' && p !== null) {
          const val = (p as { name?: string; slug?: string }).name ?? (p as { slug?: string }).slug ?? ''
          return String(val).trim().toLowerCase()
        }
        return String(p).trim().toLowerCase()
      })
      .filter(Boolean)
  }

  if (typeof palates === 'string') {
    return palates
      .split('|')
      .map((p) => p.trim().toLowerCase())
      .filter(Boolean)
  }

  return []
}

export function hasMatchingPalates(
  palates1: unknown,
  palates2: unknown,
): boolean {
  const n1 = normalizePalates(palates1)
  const n2 = normalizePalates(palates2)
  if (n1.length === 0 || n2.length === 0) return false
  return n1.some((a) => n2.some((b) => a.includes(b) || b.includes(a)))
}
