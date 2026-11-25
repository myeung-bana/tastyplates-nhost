/**
 * OpenRouter chat completions (OpenAI-compatible). Used only to write reading text.
 *
 * Configure in the Nhost dashboard (Settings → Environment variables) or `.secrets` locally:
 *   OPENROUTER_API_KEY   required — https://openrouter.ai/keys
 *   OPENROUTER_MODEL     required — any OpenRouter model id, e.g. "anthropic/claude-sonnet-4.5"
 *   OPENROUTER_BASE_URL  optional — defaults to https://openrouter.ai/api/v1
 */

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1'
const REQUEST_TIMEOUT_MS = 45_000

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

export class OpenRouterConfigError extends Error {}

export function openRouterConfig(): { apiKey: string; model: string; baseUrl: string } {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim() ?? ''
  const model = process.env.OPENROUTER_MODEL?.trim() ?? ''
  if (!apiKey) throw new OpenRouterConfigError('OPENROUTER_API_KEY is not configured')
  if (!model) throw new OpenRouterConfigError('OPENROUTER_MODEL is not configured')
  const baseUrl = (process.env.OPENROUTER_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/$/, '')
  return { apiKey, model, baseUrl }
}

/** One completion; returns the assistant text and the model that answered. */
export async function openRouterChat(
  messages: ChatMessage[],
  options?: { temperature?: number; maxTokens?: number },
): Promise<{ text: string; model: string }> {
  const { apiKey, model, baseUrl } = openRouterConfig()

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://tastyplates.co',
        'X-Title': 'TastyPlates',
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: options?.temperature ?? 0.4,
        max_tokens: options?.maxTokens ?? 1200,
        response_format: { type: 'json_object' },
      }),
    })

    const json = (await res.json().catch(() => null)) as
      | { choices?: Array<{ message?: { content?: string } }>; model?: string; error?: { message?: string } }
      | null

    if (!res.ok) {
      throw new Error(`OpenRouter ${res.status}: ${json?.error?.message ?? res.statusText}`)
    }
    const text = json?.choices?.[0]?.message?.content ?? ''
    if (!text.trim()) throw new Error('OpenRouter returned an empty reply')
    return { text, model: json?.model ?? model }
  } finally {
    clearTimeout(timer)
  }
}
