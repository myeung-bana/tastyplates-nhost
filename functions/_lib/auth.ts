export interface NhostTokenVerificationResult {
  success: boolean;
  userId?: string;
  user?: {
    id: string;
    email?: string;
    displayName?: string;
    avatarUrl?: string;
    emailVerified?: boolean;
    defaultRole?: string;
    metadata?: Record<string, any>;
  };
  error?: string;
}

export async function verifyNhostToken(
  authHeader: string | null
): Promise<NhostTokenVerificationResult> {
  if (!authHeader) return { success: false, error: 'Missing authorization header' };
  if (!authHeader.startsWith('Bearer ')) {
    return { success: false, error: 'Invalid authorization header format. Expected: Bearer <token>' };
  }

  const accessToken = authHeader.replace('Bearer ', '');
  const nhostAuthUrl =
    process.env.NHOST_AUTH_URL ||
    `https://${process.env.NHOST_SUBDOMAIN}.auth.${process.env.NHOST_REGION}.nhost.run`;

  try {
    const response = await fetch(`${nhostAuthUrl}/v1/user`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      return {
        success: false,
        error: response.status === 401 ? 'Invalid or expired token' : `Token verification failed: ${response.statusText}`,
      };
    }

    const nhostUser = await response.json() as Record<string, any>;
    if (!nhostUser?.id) return { success: false, error: 'Invalid user data from Nhost' };

    return {
      success: true,
      userId: nhostUser.id,
      user: {
        id: nhostUser.id,
        email: nhostUser.email,
        displayName: nhostUser.displayName,
        avatarUrl: nhostUser.avatarUrl,
        emailVerified: nhostUser.emailVerified,
        defaultRole: nhostUser.defaultRole,
        metadata: nhostUser.metadata,
      },
    };
  } catch (error) {
    console.error('[auth] verifyNhostToken error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Token verification failed',
    };
  }
}

export async function getNhostUserId(authHeader: string | null): Promise<string | null> {
  const result = await verifyNhostToken(authHeader);
  return result.success ? result.userId! : null;
}

export function requireAdminSecret(providedSecret: string | null | undefined): boolean {
  const adminSecret = process.env.HASURA_GRAPHQL_ADMIN_SECRET;
  return !!adminSecret && providedSecret === adminSecret;
}
