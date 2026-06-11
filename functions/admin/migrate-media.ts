/**
 * POST /v1/admin/migrate-media
 * Header: x-admin-secret
 * Query: limit (default 20), dry_run (true|false)
 *
 * Re-uploads legacy S3 image URLs to Nhost Storage and updates entity rows.
 */
import type { Request, Response } from 'express'
import process from 'node:process'

import { ADMIN_SECRET } from '../_lib/env'
import { hasuraAdmin, hasuraQuery } from '../_lib/hasura'
import type { ParsedUploadFile } from '../_lib/media-upload/types'
import { fail, ok } from '../_lib/respond'

const LEGACY_URL_PATTERN = '%amazonaws.com%'

const GET_PROFILES = `
  query MigrateProfileImages($limit: Int!, $pattern: String!) {
    user_profiles(
      where: { profile_image: { _ilike: $pattern } }
      limit: $limit
    ) {
      user_id
      profile_image
    }
  }
`

const GET_LISTS = `
  query MigrateListCovers($limit: Int!, $pattern: String!) {
    recommended_restaurant_lists(
      where: { display_pic: { _ilike: $pattern } }
      limit: $limit
    ) {
      uuid
      owner_id
      display_pic
    }
  }
`

const GET_RESTAURANTS = `
  query MigrateRestaurantImages($limit: Int!, $pattern: String!) {
    restaurants(
      where: { featured_image_url: { _ilike: $pattern } }
      limit: $limit
    ) {
      uuid
      featured_image_url
    }
  }
`

const GET_REVIEWS = `
  query MigrateReviewImages($limit: Int!) {
    restaurant_reviews(
      where: { images: { _is_null: false } }
      limit: $limit
      order_by: { updated_at: desc }
    ) {
      id
      author_id
      images
    }
  }
`

const UPDATE_PROFILE = `
  mutation MigrateProfileImage($userId: uuid!, $url: String!) {
    update_user_profiles_by_pk(pk_columns: { user_id: $userId }, _set: { profile_image: $url }) {
      user_id
    }
  }
`

const UPDATE_LIST = `
  mutation MigrateListCover($uuid: uuid!, $url: String!) {
    update_recommended_restaurant_lists_by_pk(pk_columns: { uuid: $uuid }, _set: { display_pic: $url }) {
      uuid
    }
  }
`

const UPDATE_RESTAURANT = `
  mutation MigrateRestaurantImage($uuid: uuid!, $url: String!) {
    update_restaurants(where: { uuid: { _eq: $uuid } }, _set: { featured_image_url: $url }) {
      returning { uuid }
    }
  }
`

const UPDATE_REVIEW = `
  mutation MigrateReviewImages($id: uuid!, $images: jsonb!) {
    update_restaurant_reviews_by_pk(pk_columns: { id: $id }, _set: { images: $images }) {
      id
    }
  }
`

type MigrateTask =
  | { type: 'profile'; id: string; uploadedBy: string; url: string }
  | { type: 'list'; id: string; uploadedBy: string; url: string }
  | { type: 'restaurant'; id: string; uploadedBy: string; url: string }
  | { type: 'review'; id: string; uploadedBy: string; images: string[] }

function isLegacyMediaUrl(url: string | null | undefined): boolean {
  if (!url?.trim()) return false
  const u = url.toLowerCase()
  return u.includes('amazonaws.com') || u.includes('s3.') || u.includes('.s3.')
}

function parseReviewImages(images: unknown): string[] {
  if (!Array.isArray(images)) return []
  return images.filter((v): v is string => typeof v === 'string' && v.length > 0)
}

async function fetchBytes(url: string): Promise<ParsedUploadFile | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const buffer = Buffer.from(await res.arrayBuffer())
    const contentType = res.headers.get('content-type') ?? 'image/jpeg'
    const filename = url.split('/').pop()?.split('?')[0] ?? 'migrate.jpg'
    return { buffer, mimetype: contentType, filename }
  } catch {
    return null
  }
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

    const pattern = LEGACY_URL_PATTERN
    const [profilesData, listsData, restaurantsData, reviewsData] = await Promise.all([
      hasuraQuery<{ user_profiles: Array<{ user_id: string; profile_image: string | null }> }>(
        GET_PROFILES,
        { limit, pattern },
      ),
      hasuraQuery<{
        recommended_restaurant_lists: Array<{ uuid: string; owner_id: string; display_pic: string | null }>
      }>(GET_LISTS, { limit, pattern }),
      hasuraQuery<{ restaurants: Array<{ uuid: string; featured_image_url: string | null }> }>(
        GET_RESTAURANTS,
        { limit, pattern },
      ),
      hasuraQuery<{
        restaurant_reviews: Array<{ id: string; author_id: string; images: unknown }>
      }>(GET_REVIEWS, { limit: limit * 3 }),
    ])

    const tasks: MigrateTask[] = []

    for (const row of profilesData.data?.user_profiles ?? []) {
      if (isLegacyMediaUrl(row.profile_image)) {
        tasks.push({
          type: 'profile',
          id: row.user_id,
          uploadedBy: row.user_id,
          url: row.profile_image!,
        })
      }
    }

    for (const row of listsData.data?.recommended_restaurant_lists ?? []) {
      if (isLegacyMediaUrl(row.display_pic)) {
        tasks.push({
          type: 'list',
          id: row.uuid,
          uploadedBy: row.owner_id,
          url: row.display_pic!,
        })
      }
    }

    const migrationActorId =
      url.searchParams.get('catalog_user_id')?.trim() ||
      process.env.MEDIA_MIGRATION_ACTOR_ID?.trim() ||
      null

    for (const row of restaurantsData.data?.restaurants ?? []) {
      if (isLegacyMediaUrl(row.featured_image_url) && migrationActorId) {
        tasks.push({
          type: 'restaurant',
          id: row.uuid,
          uploadedBy: migrationActorId,
          url: row.featured_image_url!,
        })
      }
    }

    for (const row of reviewsData.data?.restaurant_reviews ?? []) {
      const images = parseReviewImages(row.images)
      if (images.some(isLegacyMediaUrl)) {
        tasks.push({
          type: 'review',
          id: row.id,
          uploadedBy: row.author_id,
          images,
        })
      }
    }

    const { processMediaUpload } = await import('../_lib/media-upload/processUpload')

    const migrated: Array<{ type: string; id: string; from: string; to: string }> = []
    const skipped: string[] = []
    const errors: string[] = []

    for (const task of tasks.slice(0, limit)) {
      if (dryRun) {
        const from =
          task.type === 'review' ? task.images.filter(isLegacyMediaUrl).join(', ') : task.url
        migrated.push({ type: task.type, id: task.id, from, to: '(dry-run)' })
        continue
      }

      try {
        if (task.type === 'review') {
          const nextImages: string[] = []
          let changed = false

          for (const imageUrl of task.images) {
            if (!isLegacyMediaUrl(imageUrl)) {
              nextImages.push(imageUrl)
              continue
            }

            const file = await fetchBytes(imageUrl)
            if (!file) {
              nextImages.push(imageUrl)
              continue
            }

            const uploaded = await processMediaUpload(file, task.uploadedBy, { compress: true })
            nextImages.push(uploaded.fileUrl)
            changed = true
            migrated.push({
              type: 'review-image',
              id: task.id,
              from: imageUrl,
              to: uploaded.fileUrl,
            })
          }

          if (changed) {
            await hasuraAdmin(UPDATE_REVIEW, { id: task.id, images: nextImages })
          } else {
            skipped.push(`review:${task.id}`)
          }
          continue
        }

        const file = await fetchBytes(task.url)
        if (!file) {
          skipped.push(`${task.type}:${task.id}`)
          continue
        }

        const uploaded = await processMediaUpload(file, task.uploadedBy, { compress: true })

        if (task.type === 'profile') {
          await hasuraAdmin(UPDATE_PROFILE, { userId: task.id, url: uploaded.fileUrl })
        } else if (task.type === 'list') {
          await hasuraAdmin(UPDATE_LIST, { uuid: task.id, url: uploaded.fileUrl })
        } else {
          await hasuraAdmin(UPDATE_RESTAURANT, { uuid: task.id, url: uploaded.fileUrl })
        }

        migrated.push({ type: task.type, id: task.id, from: task.url, to: uploaded.fileUrl })
      } catch (e) {
        errors.push(`${task.type}:${task.id}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    ok(res, {
      dryRun,
      scanned: {
        profiles: profilesData.data?.user_profiles?.length ?? 0,
        lists: listsData.data?.recommended_restaurant_lists?.length ?? 0,
        restaurants: restaurantsData.data?.restaurants?.length ?? 0,
        reviews: reviewsData.data?.restaurant_reviews?.length ?? 0,
        tasks: tasks.length,
      },
      migrated,
      skipped,
      errors,
    })
  } catch (error) {
    console.error('[admin/migrate-media]', error)
    fail(res, error instanceof Error ? error.message : 'Internal server error', 500)
  }
}
