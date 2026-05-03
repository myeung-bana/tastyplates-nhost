export interface ReviewCursorPayload {
  created_at: string;
  id: string;
}

export function encodeReviewCursor(created_at: string, id: string): string {
  return Buffer.from(JSON.stringify({ created_at, id }), 'utf8').toString('base64url');
}

export function decodeReviewCursor(cursor: string): ReviewCursorPayload | null {
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as ReviewCursorPayload;
    if (typeof parsed?.created_at === 'string' && typeof parsed?.id === 'string') return parsed;
  } catch {
    // ignore
  }
  return null;
}

export interface RestaurantCursorPayload {
  created_at: string;
  id: number;
}

export function encodeRestaurantCursor(created_at: string, id: number): string {
  return Buffer.from(JSON.stringify({ created_at, id }), 'utf8').toString('base64url');
}

export function decodeRestaurantCursor(cursor: string): RestaurantCursorPayload | null {
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as RestaurantCursorPayload;
    if (typeof parsed?.created_at === 'string' && typeof parsed?.id === 'number') return parsed;
  } catch {
    // ignore
  }
  return null;
}
