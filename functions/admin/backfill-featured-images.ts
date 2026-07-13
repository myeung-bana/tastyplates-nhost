/**
 * POST /v1/admin/backfill-featured-images
 * Header: x-admin-secret
 * Query: limit (default 20, max 100), dry_run (true|false)
 *
 * For restaurants with missing or placeholder featured_image_url and a google_place_id:
 * fetches Google primary photo, ingests to Nhost Storage, updates restaurants + google_place_cache.
 */
import type { Request, Response } from 'express'
import process from 'node:process'

import { ADMIN_SECRET } from '../_lib/env'
import {
  isPlaceholderFeaturedImage,
  needsFeaturedImageBackfill,
} from '../_lib/featuredImageUtils'
import { upsertGooglePlaceCacheSafe } from '../_lib/googlePlaceCache'
import { fetchGooglePlacePhotoReference } from '../_lib/googlePlaceDetails'
import { ingestGooglePlacePhoto } from '../_lib/ingestGooglePlacePhoto'
import { hasuraAdmin, hasuraQuery } from '../_lib/hasura'
import { fail, ok } from '../_lib/respond'

const PLACEHOLDER_PATTERN = '%tastyplates_placeholder%'

const GET_CANDIDATES = `
  query BackfillFeaturedImageCandidates($limit: Int!, $placeholderPattern: String!) {
    restaurants(
      where: {
        _or: [
          { featured_image_url: { _is_null: true } }
          { featured_image_url: { _eq: "" } }
          { featured_image_url: { _ilike: $placeholderPattern } }
        ]
        google_place_id: { _is_null: false, _neq: "" }
      }
      limit: $limit
      order_by: { updated_at: desc }
    ) {
      uuid
      slug
      title
      google_place_id
      featured_image_url
    }
  }
`

const UPDATE_RESTAURANT = `
  mutation BackfillRestaurantFeaturedImage($uuid: uuid!, $url: String!) {
    update_restaurants_by_pk(pk_columns: { uuid: $uuid }, _set: { featured_image_url: $url }) {
      uuid
      featured_image_url
    }
  }
`

function migrationActorId(req: Request): string | null {
  const url = new URL(req.url, 'http://localhost')
  return (
    url.searchParams.get('catalog_user_id')?.trim() ||
    process.env.MEDIA_MIGRATION_ACTOR_ID?.trim() ||
    null
  )
}

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const adminSecret = req.headers['x-admin-secret']
    if (!adminSecret || adminSecret !== ADMIN_SECRET) {
      return fail(res, 'Unauthorized', 401)
    }

    const url = new URL(req.url, 'http://localhost')
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20', 10) || 20, 100)
    const dryRun = url.searchParams.get('dry_run') === 'true'
    const actorId = migrationActorId(req)

    if (!dryRun && !actorId) {
      return fail(
        res,
        'Missing catalog_user_id query param or MEDIA_MIGRATION_ACTOR_ID env for ingest uploads',
        400,
      )
    }

    const result = await hasuraQuery<{
      restaurants: Array<{
        uuid: string
        slug: string
        title: string
        google_place_id: string | null
        featured_image_url: string | null
      }>
    }>(GET_CANDIDATES, { limit, placeholderPattern: PLACEHOLDER_PATTERN })

    if (result.errors?.length) {
      console.error('[admin/backfill-featured-images]', result.errors)
      return fail(res, 'Failed to fetch restaurants', 500)
    }

    const candidates = (result.data?.restaurants ?? []).filter(
      (r) =>
        needsFeaturedImageBackfill(r.featured_image_url) &&
        r.google_place_id?.trim(),
    )

    const ingested: Array<{ uuid: string; slug: string; url: string }> = []
    const skipped: string[] = []
    const errors: Array<{ uuid: string; message: string }> = []

    for (const row of candidates) {
      const placeId = row.google_place_id!.trim()
      const uuid = row.uuid

      try {
        const photoRef = await fetchGooglePlacePhotoReference(placeId)
        if (!photoRef) {
          skipped.push(uuid)
          continue
        }

        if (dryRun) {
          ingested.push({ uuid, slug: row.slug, url: `[dry-run] photo_ref:${photoRef.slice(0, 12)}…` })
          continue
        }

        const fileUrl = await ingestGooglePlacePhoto(photoRef, actorId!, {
          filenameHint: `restaurant-${row.slug}`,
        })

        if (!fileUrl || isPlaceholderFeaturedImage(fileUrl)) {
          skipped.push(uuid)
          continue
        }

        await hasuraAdmin(UPDATE_RESTAURANT, { uuid, url: fileUrl })

        await upsertGooglePlaceCacheSafe({
          google_place_id: placeId,
          name: row.title,
          primary_photo_url: fileUrl,
          tastyplates_restaurant_uuid: uuid,
          tastyplates_restaurant_slug: row.slug,
        })

        ingested.push({ uuid, slug: row.slug, url: fileUrl })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        console.error(`[admin/backfill-featured-images] failed for ${uuid}`, error)
        errors.push({ uuid, message })
      }
    }

    ok(res, {
      dryRun,
      candidates: candidates.length,
      ingested: ingested.length,
      skipped: skipped.length,
      failed: errors.length,
      results: { ingested, skipped, errors },
    })
  } catch (error) {
    console.error('[admin/backfill-featured-images]', error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}
