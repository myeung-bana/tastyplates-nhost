export interface GraphQLResponse<T = any> {
  data?: T;
  errors?: Array<{
    message: string;
    extensions?: any;
  }>;
}

export async function hasuraQuery<T = any>(
  query: string,
  variables?: Record<string, any>
): Promise<GraphQLResponse<T>> {
  const HASURA_URL = process.env.NHOST_HASURA_URL || process.env.HASURA_GRAPHQL_API_URL;
  const HASURA_ADMIN_SECRET = process.env.HASURA_GRAPHQL_ADMIN_SECRET;

  if (!HASURA_URL) {
    throw new Error('NHOST_HASURA_URL or HASURA_GRAPHQL_API_URL is not configured');
  }

  const response = await fetch(`${HASURA_URL}/v1/graphql`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-hasura-admin-secret': HASURA_ADMIN_SECRET || '',
    },
    body: JSON.stringify({ query, variables: variables || {} }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(`Hasura request failed: ${response.status} ${response.statusText}. ${errorText}`);
  }

  const result = await response.json() as GraphQLResponse<T>;

  if (result.errors && result.errors.length > 0) {
    console.error('[hasura] GraphQL errors:', JSON.stringify(result.errors));
  }

  return result;
}

export async function hasuraMutation<T = any>(
  mutation: string,
  variables?: Record<string, any>
): Promise<GraphQLResponse<T>> {
  return hasuraQuery<T>(mutation, variables);
}
