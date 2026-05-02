import type { Request, Response } from 'express';
import { hasuraQuery } from '../_lib/hasura-client';
import { verifyNhostToken } from '../_lib/auth';

const GET_ME = `
  query GetMe($id: uuid!) {
    restaurant_users_by_pk(id: $id) {
      id username email display_name profile_image about_me palates
      language_preference onboarding_complete created_at updated_at
    }
  }
`;

export default async (req: Request, res: Response): Promise<void> => {
  if (req.method !== 'GET') {
    res.status(405).json({ success: false, error: 'Method not allowed' });
    return;
  }

  const authHeader = req.headers.authorization || null;
  const tokenResult = await verifyNhostToken(authHeader);

  if (!tokenResult.success) {
    res.status(401).json({ success: false, error: tokenResult.error || 'Unauthorized' });
    return;
  }

  try {
    const result = await hasuraQuery(GET_ME, { id: tokenResult.userId });

    if (result.errors) {
      console.error('[users/me] GraphQL errors:', result.errors);
      res.status(500).json({ success: false, error: result.errors[0]?.message || 'Failed to fetch user' });
      return;
    }

    const user = result.data?.restaurant_users_by_pk;
    if (!user) {
      res.status(404).json({ success: false, error: 'User profile not found' });
      return;
    }

    res.json({ success: true, data: user });
  } catch (error: any) {
    console.error('[users/me] Error:', error);
    res.status(500).json({ success: false, error: error.message || 'Internal server error' });
  }
};
