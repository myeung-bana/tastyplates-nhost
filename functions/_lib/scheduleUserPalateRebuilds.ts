import { hasuraQuery } from './hasura'
import { schedulePalateRatingSummaryRebuild } from './rebuildPalateRatingSummary'
import { scheduleRatingSummaryRebuild } from './rebuildRatingSummary'

const GET_REVIEWED_RESTAURANTS = `
  query GetReviewedRestaurantsForUser($authorId: uuid!) {
    restaurant_reviews(
      where: {
        author_id: { _eq: $authorId }
        deleted_at: { _is_null: true }
        parent_review_id: { _is_null: true }
        status: { _eq: "approved" }
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

      for (const uuid of uuids) {
        scheduleRatingSummaryRebuild(uuid)
        schedulePalateRatingSummaryRebuild(uuid, 'first_party')
      }
    } catch (error) {
      console.error('[scheduleUserPalateRebuilds] failed:', authorId, error)
    }
  })()
}
