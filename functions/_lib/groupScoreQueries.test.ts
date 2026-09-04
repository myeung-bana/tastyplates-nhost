import { describe, expect, it } from 'vitest'

/**
 * Mirrors pickWinningRow tie-break logic from groupScoreQueries.ts.
 */
function pickWinningRow(
  rows: Array<{ cuisine_id: number; review_count: number; reviewer_count: number }>,
  parentSlugById: Map<number, string>,
): (typeof rows)[number] | null {
  if (rows.length === 0) return null
  return [...rows].sort((a, b) => {
    if (b.review_count !== a.review_count) return b.review_count - a.review_count
    if (b.reviewer_count !== a.reviewer_count) return b.reviewer_count - a.reviewer_count
    const slugA = parentSlugById.get(a.cuisine_id) ?? ''
    const slugB = parentSlugById.get(b.cuisine_id) ?? ''
    return slugA.localeCompare(slugB)
  })[0]
}

describe('group score winner selection', () => {
  it('picks the parent group with the most reviews', () => {
    const parentSlugById = new Map([
      [1, 'east-asian'],
      [2, 'european'],
    ])
    const winner = pickWinningRow(
      [
        { cuisine_id: 1, review_count: 5, reviewer_count: 3 },
        { cuisine_id: 2, review_count: 8, reviewer_count: 2 },
      ],
      parentSlugById,
    )
    expect(winner?.cuisine_id).toBe(2)
  })

  it('breaks review_count ties by reviewer_count then slug', () => {
    const parentSlugById = new Map([
      [1, 'east-asian'],
      [2, 'european'],
    ])
    const winner = pickWinningRow(
      [
        { cuisine_id: 1, review_count: 5, reviewer_count: 4 },
        { cuisine_id: 2, review_count: 5, reviewer_count: 2 },
      ],
      parentSlugById,
    )
    expect(winner?.cuisine_id).toBe(1)

    const slugTie = pickWinningRow(
      [
        { cuisine_id: 2, review_count: 5, reviewer_count: 4 },
        { cuisine_id: 1, review_count: 5, reviewer_count: 4 },
      ],
      parentSlugById,
    )
    expect(slugTie?.cuisine_id).toBe(1)
  })
})
