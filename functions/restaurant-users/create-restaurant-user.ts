import type { Request, Response } from 'express'
import {
  createUserProfile,
  getProfileById,
  toLegacyUser,
} from '../_lib/user-profile'
import { resolveAuth } from '../_lib/auth-guard'
import { ok, fail } from '../_lib/respond'

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const auth = await resolveAuth(req, res)
    if (!auth) return

    const body = req.body as {
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
