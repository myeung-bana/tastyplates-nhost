import process from 'node:process'

import { NHOST_REGION, NHOST_SUBDOMAIN } from './env'

export function getApifyToken(): string | null {
  const token = process.env.APIFY_TOKEN?.trim()
  return token || null
}

export function getApifyGoogleActorId(): string | null {
  const id = process.env.APIFY_GOOGLE_ACTOR_ID?.trim()
  return id || null
}

export function getApifyWebhookSecret(): string | null {
  const secret = process.env.APIFY_WEBHOOK_SECRET?.trim()
  return secret || null
}

export function getFunctionsPublicBaseUrl(): string {
  const override = process.env.NHOST_FUNCTIONS_PUBLIC_URL?.trim()
  if (override) return override.replace(/\/$/, '')
  return `https://${NHOST_SUBDOMAIN}.functions.${NHOST_REGION}.nhost.run/v1`
}

export function requireApifyConfig(): { token: string; actorId: string } {
  const token = getApifyToken()
  const actorId = getApifyGoogleActorId()
  if (!token) {
    throw new Error('APIFY_TOKEN is not configured')
  }
  if (!actorId) {
    throw new Error('APIFY_GOOGLE_ACTOR_ID is not configured')
  }
  return { token, actorId }
}

export interface StartApifyRunInput {
  actorId: string
  token: string
  input: Record<string, unknown>
  webhookUrl: string
  webhookSecret: string
}

export interface ApifyRunStartResult {
  runId: string
  datasetId: string | null
  status: string
}

export async function startApifyActorRun(options: StartApifyRunInput): Promise<ApifyRunStartResult> {
  const actorRef = encodeURIComponent(options.actorId)
  const url = `https://api.apify.com/v2/acts/${actorRef}/runs?token=${encodeURIComponent(options.token)}`

  const body = {
    ...options.input,
    webhooks: [
      {
        eventTypes: ['ACTOR.RUN.SUCCEEDED', 'ACTOR.RUN.FAILED', 'ACTOR.RUN.ABORTED', 'ACTOR.RUN.TIMED_OUT'],
        requestUrl: options.webhookUrl,
        payloadTemplate: '{"eventType":"{{eventType}}","resource":{"id":"{{resource.id}}","defaultDatasetId":"{{resource.defaultDatasetId}}","status":"{{resource.status}}","statusMessage":"{{resource.statusMessage}}"}}',
        headersTemplate: `{"Content-Type":"application/json","x-apify-webhook-secret":"${options.webhookSecret}"}`,
      },
    ],
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Apify run failed (${response.status}): ${text.slice(0, 500)}`)
  }

  const json = (await response.json()) as {
    data?: { id?: string; defaultDatasetId?: string; status?: string }
  }

  const runId = json.data?.id
  if (!runId) {
    throw new Error('Apify did not return a run id')
  }

  return {
    runId,
    datasetId: json.data?.defaultDatasetId ?? null,
    status: json.data?.status ?? 'RUNNING',
  }
}

export async function fetchApifyDatasetItems(
  datasetId: string,
  token: string,
): Promise<Record<string, unknown>[]> {
  const url = `https://api.apify.com/v2/datasets/${encodeURIComponent(datasetId)}/items?token=${encodeURIComponent(token)}&clean=true&format=json`

  const response = await fetch(url)
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Apify dataset fetch failed (${response.status}): ${text.slice(0, 500)}`)
  }

  const items = (await response.json()) as unknown
  if (!Array.isArray(items)) {
    return []
  }

  return items.filter((item): item is Record<string, unknown> => item != null && typeof item === 'object')
}
