import { randomBytes } from 'node:crypto'

import { assertUuid, hasuraRunSql } from './hasura-run-sql'
import { storageAdminSecret, storageBaseUrl } from './media-upload/config'

export const DELETION_GRACE_DAYS = 30

export interface AccountDeletionState {
  deletion_requested_at: string | null
  deletion_scheduled_for: string | null
  anonymized_at: string | null
}

export interface AnonymiseResult {
  userId: string
  reviewsAnonymised: number
  filesDeleted: number
  filesKept: number
}

const STORAGE_FILE_ID = /\/v1\/files\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i

export async function getDeletionState(userId: string): Promise<AccountDeletionState | null> {
  const id = assertUuid(userId, 'userId')
  const rows = await hasuraRunSql<Record<string, unknown>>(
    `SELECT deletion_requested_at, deletion_scheduled_for, anonymized_at
       FROM public.user_profiles WHERE user_id::text = '${id}' LIMIT 1`,
    { readOnly: true },
  )
  const row = rows[0]
  if (!row) return null
  return {
    deletion_requested_at: (row.deletion_requested_at as string | null) ?? null,
    deletion_scheduled_for: (row.deletion_scheduled_for as string | null) ?? null,
    anonymized_at: (row.anonymized_at as string | null) ?? null,
  }
}

export function isDeletionPending(state: AccountDeletionState | null): boolean {
  return Boolean(state?.deletion_scheduled_for && !state.anonymized_at)
}

/** Hides the profile now and schedules anonymisation; signs the user out of every device. */
export async function requestAccountDeletion(userId: string): Promise<string> {
  const id = assertUuid(userId, 'userId')
  const rows = await hasuraRunSql<{ deletion_scheduled_for: string }>(
    `UPDATE public.user_profiles
        SET deleted_at = COALESCE(deleted_at, now()),
            deletion_requested_at = COALESCE(deletion_requested_at, now()),
            deletion_scheduled_for = COALESCE(deletion_scheduled_for, now() + interval '${DELETION_GRACE_DAYS} days')
      WHERE user_id::text = '${id}' AND anonymized_at IS NULL
      RETURNING deletion_scheduled_for`,
  )
  const scheduled = rows[0]?.deletion_scheduled_for
  if (!scheduled) throw new Error('requestAccountDeletion: profile not found or already anonymised')
  await revokeSessions(id)
  return scheduled
}

export async function revokeSessions(userId: string): Promise<void> {
  const id = assertUuid(userId, 'userId')
  await hasuraRunSql(`DELETE FROM auth.refresh_tokens WHERE user_id::text = '${id}'`)
}

export async function restoreAccount(userId: string): Promise<boolean> {
  const id = assertUuid(userId, 'userId')
  const rows = await hasuraRunSql<{ user_id: string }>(
    `UPDATE public.user_profiles
        SET deleted_at = NULL, deletion_requested_at = NULL, deletion_scheduled_for = NULL
      WHERE user_id::text = '${id}'
        AND deletion_scheduled_for IS NOT NULL
        AND anonymized_at IS NULL
      RETURNING user_id`,
  )
  return rows.length > 0
}

export async function listAccountsDueForPurge(limit: number): Promise<string[]> {
  const rows = await hasuraRunSql<{ user_id: string }>(
    `SELECT user_id::text AS user_id FROM public.user_profiles
      WHERE deletion_scheduled_for IS NOT NULL
        AND deletion_scheduled_for <= now()
        AND anonymized_at IS NULL
      ORDER BY deletion_scheduled_for
      LIMIT ${Math.max(1, Math.min(limit, 200))}`,
    { readOnly: true },
  )
  return rows.map((r) => String(r.user_id).trim())
}

async function deleteStorageFile(fileId: string): Promise<boolean> {
  const res = await fetch(`${storageBaseUrl()}/v1/files/${fileId}`, {
    method: 'DELETE',
    headers: { 'x-hasura-admin-secret': storageAdminSecret() },
  })
  return res.ok || res.status === 404
}

/** Storage file IDs owned by the user, excluding any reused as a restaurant featured image. */
async function collectOwnedStorageFiles(userId: string): Promise<{ owned: string[]; kept: number }> {
  const rows = await hasuraRunSql<{ url: string | null }>(
    `SELECT img->>'url' AS url
       FROM public.restaurant_reviews r,
            LATERAL jsonb_array_elements(COALESCE(r.images::jsonb, '[]'::jsonb)) img
      WHERE r.author_id::text = '${userId}'
     UNION ALL
     SELECT img->>'thumbnail_url'
       FROM public.restaurant_reviews r,
            LATERAL jsonb_array_elements(COALESCE(r.images::jsonb, '[]'::jsonb)) img
      WHERE r.author_id::text = '${userId}'
     UNION ALL
     SELECT avatar_url FROM auth.users WHERE id::text = '${userId}'`,
    { readOnly: true },
  )
  const ids = new Set<string>()
  for (const row of rows) {
    const match = row.url ? STORAGE_FILE_ID.exec(row.url) : null
    if (match) ids.add(match[1].toLowerCase())
  }
  if (ids.size === 0) return { owned: [], kept: 0 }

  const patterns = [...ids].map((fid) => `'%${fid}%'`).join(', ')
  const featured = await hasuraRunSql<{ featured_image_url: string }>(
    `SELECT featured_image_url FROM public.restaurants
      WHERE featured_image_url ILIKE ANY (ARRAY[${patterns}])`,
    { readOnly: true },
  )
  const keep = new Set<string>()
  for (const row of featured) {
    const match = STORAGE_FILE_ID.exec(row.featured_image_url)
    if (match) keep.add(match[1].toLowerCase())
  }
  return { owned: [...ids].filter((fid) => !keep.has(fid)), kept: keep.size }
}

/**
 * Irreversibly anonymises an account. Reviews and comments stay (ratings depend on them) but are
 * detached from any identity and stripped of photos; everything else tied to the user is removed.
 * The auth row is scrubbed and disabled rather than deleted so FK references from content stay valid.
 */
export async function anonymiseAccount(userId: string): Promise<AnonymiseResult> {
  const id = assertUuid(userId, 'userId')
  const { owned, kept } = await collectOwnedStorageFiles(id)
  const placeholder = `deleted_${randomBytes(5).toString('hex')}`

  const [reviewCount] = await hasuraRunSql<{ count: string }>(
    `SELECT count(*)::int AS count FROM public.restaurant_reviews WHERE author_id::text = '${id}'`,
    { readOnly: true },
  )

  await hasuraRunSql(
    `DELETE FROM public.user_favorites WHERE user_id::text = '${id}';
     DELETE FROM public.user_checkins WHERE user_id::text = '${id}';
     DELETE FROM public.restaurant_user_follows
      WHERE follower_id::text = '${id}' OR user_id::text = '${id}';
     DELETE FROM public.restaurant_review_likes WHERE user_id::text = '${id}';
     DELETE FROM public.recommended_restaurant_list_items
      WHERE list_id IN (SELECT uuid FROM public.recommended_restaurant_lists WHERE owner_id::text = '${id}');
     DELETE FROM public.recommended_restaurant_lists WHERE owner_id::text = '${id}';
     DO $$ BEGIN
       IF to_regclass('public.user_blocks') IS NOT NULL THEN
         DELETE FROM public.user_blocks WHERE blocker_id::text = '${id}' OR blocked_id::text = '${id}';
       END IF;
       IF to_regclass('public.content_reports') IS NOT NULL THEN
         UPDATE public.content_reports SET reporter_id = NULL WHERE reporter_id::text = '${id}';
       END IF;
     END $$;
     UPDATE public.restaurant_reviews
        SET images = NULL
      WHERE author_id::text = '${id}';
     UPDATE public.user_profiles
        SET username = '${placeholder}',
            about_me = NULL, birthdate = NULL, gender = NULL, pronoun = NULL, palates = NULL,
            address = NULL, zip_code = NULL, latitude = NULL, longitude = NULL,
            current_location_id = NULL, current_location_slug = NULL,
            current_latitude = NULL, current_longitude = NULL,
            current_location_label = NULL, current_google_place_id = NULL,
            hometown_location_id = NULL, hometown_location_slug = NULL,
            hometown_latitude = NULL, hometown_longitude = NULL,
            hometown_location_label = NULL, hometown_google_place_id = NULL,
            deleted_at = COALESCE(deleted_at, now()),
            anonymized_at = now()
      WHERE user_id::text = '${id}';
     DELETE FROM auth.refresh_tokens WHERE user_id::text = '${id}';
     DELETE FROM auth.user_providers WHERE user_id::text = '${id}';
     DELETE FROM auth.user_security_keys WHERE user_id::text = '${id}';
     UPDATE auth.users
        SET email = '${id}@deleted.tastyplates.invalid',
            new_email = NULL, phone_number = NULL, password_hash = NULL,
            display_name = 'Deleted user', avatar_url = '', metadata = '{}'::jsonb,
            email_verified = false, phone_number_verified = false, disabled = true
      WHERE id::text = '${id}';`,
  )

  let filesDeleted = 0
  for (const fileId of owned) {
    try {
      if (await deleteStorageFile(fileId)) filesDeleted += 1
    } catch (error) {
      console.error('[accountDeletion] storage delete failed', fileId, error)
    }
  }

  return { userId: id, reviewsAnonymised: Number(reviewCount?.count ?? 0), filesDeleted, filesKept: kept }
}
