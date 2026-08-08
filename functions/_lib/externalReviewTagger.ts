import type { ExternalReviewSentiment } from './externalReviewTypes'

/** Canonical palate slugs — keep aligned with restaurant_palates / app picker. */
export const PALATE_KEYWORD_MAP: Record<string, string[]> = {
  spicy: ['spicy', 'hot', 'chilli', 'chili', 'fiery', 'numbing', 'mala'],
  umami: ['savory', 'savoury', 'umami', 'rich', 'deep', 'broth'],
  sweet: ['sweet', 'sugary', 'dessert', 'caramel', 'honey'],
  sour: ['sour', 'tangy', 'acidic', 'citrus', 'vinegar', 'tamarind'],
  salty: ['salty', 'briny', 'seasoned'],
  smoky: ['smoky', 'grilled', 'charred', 'bbq', 'barbecue'],
  fresh: ['fresh', 'light', 'clean', 'crisp'],
  creamy: ['creamy', 'buttery', 'silky', 'velvety'],
  crunchy: ['crunchy', 'crispy', 'fried', 'crackling'],
}

const LANGUAGE_HINTS: Record<string, RegExp[]> = {
  en: [/\b(the|and|was|very|good|great|food|service)\b/i],
  zh: [/[\u4e00-\u9fff]/],
  ms: [/\b(sangat|makanan|sedap|restoran|perkhidmatan)\b/i],
  ja: [/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/],
  ko: [/[\uac00-\ud7af]/],
  th: [/[\u0e00-\u0e7f]/],
}

const POSITIVE_WORDS = ['great', 'excellent', 'amazing', 'love', 'delicious', 'fantastic', 'best', 'perfect']
const NEGATIVE_WORDS = ['bad', 'terrible', 'awful', 'worst', 'disappoint', 'horrible', 'never', 'rude', 'cold']

export function detectLanguage(body: string | null | undefined): string | null {
  const text = body?.trim()
  if (!text) return null

  let bestLang: string | null = null
  let bestScore = 0

  for (const [lang, patterns] of Object.entries(LANGUAGE_HINTS)) {
    let score = 0
    for (const pattern of patterns) {
      if (pattern.test(text)) score += 1
    }
    if (score > bestScore) {
      bestScore = score
      bestLang = lang
    }
  }

  return bestScore > 0 ? bestLang : null
}

export function inferPalates(body: string | null | undefined): string[] {
  const text = body?.trim().toLowerCase()
  if (!text) return []

  const found = new Set<string>()
  for (const [slug, keywords] of Object.entries(PALATE_KEYWORD_MAP)) {
    if (keywords.some((kw) => text.includes(kw))) {
      found.add(slug)
    }
  }
  return [...found]
}

export function inferSentiment(
  rating: number,
  body: string | null | undefined,
): ExternalReviewSentiment {
  const text = body?.trim().toLowerCase() ?? ''

  if (rating >= 4.5) return 'positive'
  if (rating <= 2) return 'negative'

  const hasPositive = POSITIVE_WORDS.some((w) => text.includes(w))
  const hasNegative = NEGATIVE_WORDS.some((w) => text.includes(w))

  if (hasPositive && !hasNegative) return 'positive'
  if (hasNegative && !hasPositive) return 'negative'
  if (rating >= 4) return 'positive'
  if (rating <= 3) return 'negative'
  return 'neutral'
}

export function tagExternalReview(body: string | null | undefined, rating: number): {
  language: string | null
  palates: string[]
  sentiment: ExternalReviewSentiment
} {
  return {
    language: detectLanguage(body),
    palates: inferPalates(body),
    sentiment: inferSentiment(rating, body),
  }
}
