import type { Request, Response } from 'express';
import { hasuraMutation } from '../_lib/hasura-client';
import { SOFT_DELETE_RESTAURANT_USER, DELETE_RESTAURANT_USER } from '../_lib/graphql/user-queries';
import { isValidUUID } from '../_lib/validate';

export default async (req: Request, res: Response): Promise<void> => {
  if (req.method !== 'DELETE') {
    res.status(405).json({ success: false, error: 'Method not allowed' });
    return;
  }

  const id = req.query.id as string;
  const hardDelete = req.query.hard_delete === 'true';

  if (!id) {
    res.status(400).json({ success: false, error: 'User ID is required' });
    return;
  }

  if (!isValidUUID(id)) {
    res.status(400).json({ success: false, error: 'Invalid user ID format. Expected UUID.' });
    return;
  }

  try {
    const mutation = hardDelete ? DELETE_RESTAURANT_USER : SOFT_DELETE_RESTAURANT_USER;
    const result = await hasuraMutation(mutation, { id });

    if (result.errors) {
      console.error('[users/delete] GraphQL errors:', result.errors);
      res.status(500).json({ success: false, error: result.errors[0]?.message || 'Failed to delete user' });
      return;
    }

    const deletedUser = hardDelete
      ? result.data?.delete_restaurant_users_by_pk
      : result.data?.update_restaurant_users_by_pk;

    if (!deletedUser) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    res.json({
      success: true,
      data: deletedUser,
      message: hardDelete ? 'User permanently deleted' : 'User soft deleted',
    });
  } catch (error: any) {
    console.error('[users/delete] Error:', error);
    res.status(500).json({ success: false, error: error.message || 'Internal server error' });
  }
};
