import { hasuraQuery } from './hasura'
import { scheduleRatingSummaryRebuild } from './rebuildRatingSummary'
import { PUBLIC_REVIEW_STATUS_WHERE } from './reviewPool'

const GET_REVIEWED_RESTAURANTS = `
  query GetReviewedRestaurantsForUser($authorId: uuid!) {
    restaurant_reviews(
      where: {
        author_id: { _eq: $authorId }
        deleted_at: { _is_null: true }
        parent_review_id: { _is_null: true }
        ${PUBLIC_REVIEW_STATUS_WHERE}
      }
      distinct_on: restaurant_uuid
    ) {
      restaurant_uuid
    }
  }
`

/** Rebuild rating summaries for restaurants this user has reviewed after palate changes. */
export function scheduleUserPalateRebuilds(userId: string): void {
  const authorId = userId.trim()
  if (!authorId) return

  void (async () => {
    try {
      const result = await hasuraQuery<{
        restaurant_reviews: Array<{ restaurant_uuid: string | null }>
      }>(GET_REVIEWED_RESTAURANTS, { authorId })

      if (result.errors?.length) {
        console.error('[scheduleUserPalateRebuilds] query error:', result.errors)
        return
      }

      const uuids = [
        ...new Set(
          (result.data?.restaurant_reviews ?? [])
            .map((row) => row.restaurant_uuid?.trim())
            .filter((uuid): uuid is string => Boolean(uuid)),
        ),
      ]

      // Rebuilds Overall/Authentic and then both palate sources for each restaurant.
      for (const uuid of uuids) scheduleRatingSummaryRebuild(uuid)
    } catch (error) {
      console.error('[scheduleUserPalateRebuilds] failed:', authorId, error)
    }
  })()
}
