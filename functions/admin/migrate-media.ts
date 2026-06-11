/**
 * POST /v1/admin/migrate-media
 * Header: x-admin-secret
 * Query: limit (default 20), dry_run (true|false)
 *
 * Re-uploads legacy S3/http image URLs to Nhost Storage and updates entity rows.
 */
import type { Request, Response } from 'express'

import { ADMIN_SECRET } from '../_lib/env'
import { hasuraAdmin, hasuraQuery } from '../_lib/hasura'
import { processMediaUpload } from '../_lib/media-upload/processUpload'
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
      display_pic
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

function isLegacyMediaUrl(url: string | null | undefined): boolean {
  if (!url?.trim()) return false
  const u = url.toLowerCase()
  return u.includes('amazonaws.com') || u.includes('s3.') || u.includes('.s3.')
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
    const [profilesData, listsData] = await Promise.all([
      hasuraQuery<{ user_profiles: Array<{ user_id: string; profile_image: string | null }> }>(
        GET_PROFILES,
        { limit, pattern },
      ),
      hasuraQuery<{ recommended_restaurant_lists: Array<{ uuid: string; display_pic: string | null }> }>(
        GET_LISTS,
        { limit, pattern },
      ),
    ])

    const profiles = profilesData.data?.user_profiles ?? []
    const lists = listsData.data?.recommended_restaurant_lists ?? []

    const migrated: Array<{ type: string; id: string; from: string; to: string }> = []
    const skipped: string[] = []
    const errors: string[] = []

    const tasks: Array<{ type: 'profile' | 'list'; id: string; url: string }> = []
    for (const row of profiles) {
      if (isLegacyMediaUrl(row.profile_image)) {
        tasks.push({ type: 'profile', id: row.user_id, url: row.profile_image! })
      }
    }
    for (const row of lists) {
      if (isLegacyMediaUrl(row.display_pic)) {
        tasks.push({ type: 'list', id: row.uuid, url: row.display_pic! })
      }
    }

    for (const task of tasks.slice(0, limit)) {
      if (dryRun) {
        migrated.push({ type: task.type, id: task.id, from: task.url, to: '(dry-run)' })
        continue
      }

      const file = await fetchBytes(task.url)
      if (!file) {
        skipped.push(`${task.type}:${task.id}`)
        continue
      }

      try {
        const uploaded = await processMediaUpload(file, task.id, { compress: true })
        if (task.type === 'profile') {
          await hasuraAdmin(UPDATE_PROFILE, { userId: task.id, url: uploaded.fileUrl })
        } else {
          await hasuraAdmin(UPDATE_LIST, { uuid: task.id, url: uploaded.fileUrl })
        }
        migrated.push({ type: task.type, id: task.id, from: task.url, to: uploaded.fileUrl })
      } catch (e) {
        errors.push(`${task.type}:${task.id}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    ok(res, {
      dryRun,
      scanned: { profiles: profiles.length, lists: lists.length },
      migrated,
      skipped,
      errors,
    })
  } catch (error) {
    console.error('[admin/migrate-media]', error)
    fail(res, error instanceof Error ? error.message : 'Internal server error', 500)
  }
}
