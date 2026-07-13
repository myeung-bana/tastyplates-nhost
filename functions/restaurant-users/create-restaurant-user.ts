import type { Request, Response } from 'express'
import {
  createUserProfile,
  getProfileById,
  toLegacyUser,
  updateUserProfile,
} from '../_lib/user-profile'
import { buildUserLocationProfileChanges } from '../_lib/userLocationProfile'
import { resolveAuth } from '../_lib/auth-guard'
import { ok, fail } from '../_lib/respond'

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const auth = await resolveAuth(req, res)
    if (!auth) return

    const body = req.body as Record<string, unknown> & {
      username?: string
      about_me?: string
      birthdate?: string
      gender?: string
      pronoun?: string
      palates?: unknown
      onboarding_complete?: boolean
    }

    if (!body.username || typeof body.username !== 'string') {
      return fail(res, 'username is required', 400)
    }

    const existing = await getProfileById(auth.userId)
    if (existing) {
      return fail(res, 'Profile already exists for this user', 409)
    }

    let locationFields: Record<string, unknown> = {}
    try {
      locationFields = await buildUserLocationProfileChanges(body)
    } catch (locationError) {
      const message =
        locationError instanceof Error ? locationError.message : 'Invalid location'
      return fail(res, message, 400)
    }

    await createUserProfile({
      user_id: auth.userId,
      username: body.username,
      about_me: body.about_me ?? null,
      birthdate: body.birthdate ?? null,
      gender: body.gender ?? null,
      pronoun: body.pronoun ?? null,
      palates: body.palates ?? null,
      onboarding_complete: body.onboarding_complete ?? false,
    })

    if (Object.keys(locationFields).length > 0) {
      await updateUserProfile(auth.userId, {
        ...locationFields,
        updated_at: new Date().toISOString(),
      })
    }

    const profile = await getProfileById(auth.userId)
    if (!profile) {
      return fail(res, 'Profile created but could not be loaded', 500)
    }

    ok(res, { user: toLegacyUser(profile) }, 201)
  } catch (error) {
    console.error('[restaurant-users/create-restaurant-user]', error)
    fail(res, 'Internal server error', 500)
  }
}
