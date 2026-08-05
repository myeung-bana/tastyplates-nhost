import { getFunctionsBaseUrl } from './admin-api-auth'

export const MCP_PACKAGE_NAME = 'tastyplates-admin-mcp'

export const MCP_TOOLS = [
  { name: 'list_restaurants', description: 'Search and list restaurant listings' },
  { name: 'get_restaurant', description: 'Get a restaurant by UUID' },
  { name: 'create_restaurant', description: 'Create a new restaurant listing' },
  { name: 'update_restaurant', description: 'Update an existing restaurant listing' },
  { name: 'search_places', description: 'Search Google Places by name/address' },
  { name: 'get_place_details', description: 'Get Google Place details by place_id' },
  { name: 'create_restaurant_from_place', description: 'Create a draft listing from a Google place_id' },
  { name: 'list_reviews', description: 'List platform reviews with filters' },
  { name: 'get_review', description: 'Get a single review by ID' },
  { name: 'update_review', description: 'Update review status or content' },
  { name: 'get_external_data', description: 'Get Apify external data for a restaurant' },
  { name: 'trigger_external_scrape', description: 'Trigger Apify scrape for a restaurant' },
  { name: 'list_cuisines', description: 'List cuisine taxonomy' },
  { name: 'list_categories', description: 'List category taxonomy' },
  { name: 'list_price_ranges', description: 'List price range options' },
] as const

export function getAdminApiUrl(): string {
  return getFunctionsBaseUrl()
}

export function buildClaudeDesktopConfig(apiKey: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        'tastyplates-admin': {
          command: 'npx',
          args: ['-y', MCP_PACKAGE_NAME],
          env: {
            TASTYPLATES_API_URL: getAdminApiUrl(),
            TASTYPLATES_MCP_API_KEY: apiKey,
          },
        },
      },
    },
    null,
    2,
  )
}

export function buildCursorMcpConfig(apiKey: string): string {
  return buildClaudeDesktopConfig(apiKey)
}

export function buildClaudeCodeCommand(apiKey: string): string {
  return `claude mcp add tastyplates-admin --env TASTYPLATES_API_URL=${getAdminApiUrl()} --env TASTYPLATES_MCP_API_KEY=${apiKey} -- npx -y ${MCP_PACKAGE_NAME}`
}

export function buildLocalDevConfig(apiKey: string, monorepoPath?: string): string {
  if (!monorepoPath?.trim()) return buildClaudeDesktopConfig(apiKey)
  return JSON.stringify(
    {
      mcpServers: {
        'tastyplates-admin': {
          command: 'node',
          args: [`${monorepoPath.replace(/\/$/, '')}/dist/index.js`],
          env: {
            TASTYPLATES_API_URL: getAdminApiUrl(),
            TASTYPLATES_MCP_API_KEY: apiKey,
          },
        },
      },
    },
    null,
    2,
  )
}
