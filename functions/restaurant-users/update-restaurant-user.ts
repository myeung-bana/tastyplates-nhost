import type { Request, Response } from 'express'
import {
  getProfileById,
  toLegacyUser,
  updateUserAvatar,
  updateUserDisplayName,
  updateUserLocale,
  updateUserProfile,
} from '../_lib/user-profile'
import { buildUserLocationProfileChanges } from '../_lib/userLocationProfile'
import { resolveAuth } from '../_lib/auth-guard'
import { ok, fail } from '../_lib/respond'

const ALLOWED_LOCALES = ['en', 'zh', 'ko'] as const

function resolveAvatarUrl(profileImage: unknown): string | null {
  if (typeof profileImage === 'string' && profileImage.startsWith('http')) {
    return profileImage
  }
  if (
    profileImage &&
    typeof profileImage === 'object' &&
    typeof (profileImage as { url?: string }).url === 'string' &&
    (profileImage as { url: string }).url.startsWith('http')
  ) {
    return (profileImage as { url: string }).url
  }
  return null
}

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const auth = await resolveAuth(req, res)
    if (!auth) return

    const body = req.body as Record<string, unknown> & {
      username?: string
      display_name?: string
      about_me?: string
      profile_image?: unknown
      birthdate?: string
      gender?: string
      pronoun?: string
      palates?: unknown
      language_preference?: string
      onboarding_complete?: boolean
    }

    const existing = await getProfileById(auth.userId)
    if (!existing) return fail(res, 'User not found', 404)

    const avatarUrl =
      body.profile_image !== undefined ? resolveAvatarUrl(body.profile_image) : null

    const profileChanges: Record<string, unknown> = {}
    if (body.username !== undefined) profileChanges.username = body.username
    if (body.about_me !== undefined) profileChanges.about_me = body.about_me
    if (body.birthdate !== undefined) profileChanges.birthdate = body.birthdate
    if (body.gender !== undefined) profileChanges.gender = body.gender
    if (body.pronoun !== undefined) profileChanges.pronoun = body.pronoun
    if (body.palates !== undefined) profileChanges.palates = body.palates
    if (body.onboarding_complete !== undefined) {
      profileChanges.onboarding_complete = body.onboarding_complete
    }

    try {
      const locationChanges = await buildUserLocationProfileChanges(body)
      Object.assign(profileChanges, locationChanges)
    } catch (locationError) {
      const message =
        locationError instanceof Error ? locationError.message : 'Invalid location'
      return fail(res, message, 400)
    }

    const hasProfileChanges = Object.keys(profileChanges).length > 0
    const hasLocaleChange = body.language_preference !== undefined
    const hasDisplayNameChange =
      body.display_name !== undefined && body.display_name !== ''
    const hasAvatarChange = avatarUrl !== null

    if (!hasProfileChanges && !hasLocaleChange && !hasDisplayNameChange && !hasAvatarChange) {
      return fail(res, 'No fields to update', 400)
    }

    const tasks: Promise<unknown>[] = []

    if (hasProfileChanges) {
      profileChanges.updated_at = new Date().toISOString()
      tasks.push(updateUserProfile(auth.userId, profileChanges))
    }
    if (hasAvatarChange && avatarUrl) {
      tasks.push(updateUserAvatar(auth.userId, avatarUrl))
    }
    if (hasLocaleChange) {
      const locale = ALLOWED_LOCALES.includes(
        body.language_preference as (typeof ALLOWED_LOCALES)[number],
      )
        ? body.language_preference!
        : 'en'
      tasks.push(updateUserLocale(auth.userId, locale))
    }
    if (hasDisplayNameChange && body.display_name) {
      tasks.push(updateUserDisplayName(auth.userId, body.display_name))
    }

    await Promise.all(tasks)

    const profile = await getProfileById(auth.userId)
    if (!profile) return fail(res, 'User not found after update', 404)

    ok(res, { user: toLegacyUser(profile) })
  } catch (error) {
    console.error('[restaurant-users/update-restaurant-user]', error)
    fail(res, 'Internal server error', 500)
  }
}
