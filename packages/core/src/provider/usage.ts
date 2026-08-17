// Adapted from opencode (MIT). Source: packages/opencode/src/session/session.ts:340-380
// https://github.com/anomalyco/opencode — see licenses/opencode-MIT.txt

import type { Tokens } from "@compass/schema"
import type { LanguageModelUsage } from "ai"

/** Providers omit fields freely and occasionally disagree with themselves; never go negative. */
const safe = (value: number) => (Number.isFinite(value) && value > 0 ? Math.round(value) : 0)

/**
 * Normalizes the AI SDK's usage report into the split we store.
 *
 * Two subtractions carry the whole weight of this function, and both exist
 * because the SDK reports overlapping totals:
 *
 * `inputTokens` includes cache reads and writes. The AI SDK normalized this
 * across providers — Anthropic and Bedrock used to exclude them — so cached
 * counts are subtracted out and carried separately. Storing them twice would
 * make every cached turn look roughly double its real size, and overflow
 * detection would compact conversations that fit perfectly well.
 *
 * `outputTokens` includes reasoning tokens, which are billed and counted but
 * never appear in the reply.
 *
 * Returns undefined when the provider reported nothing at all, which is not the
 * same as reporting zero — see the nullable columns in migration 0001.
 */
export function toTokens(usage: LanguageModelUsage | undefined): Tokens | undefined {
  if (!usage) return undefined

  const cacheRead = safe(usage.inputTokenDetails?.cacheReadTokens ?? 0)
  const cacheWrite = safe(usage.inputTokenDetails?.cacheWriteTokens ?? 0)
  const reasoning = safe(usage.outputTokenDetails?.reasoningTokens ?? 0)
  const input = safe(usage.inputTokens ?? 0)
  const output = safe(usage.outputTokens ?? 0)
  const total = usage.totalTokens

  // A provider that reported literally nothing usable leaves no trace, rather
  // than a row of zeroes that reads as a free turn.
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0 && total === undefined) return undefined

  return {
    input: safe(input - cacheRead - cacheWrite),
    output: safe(output - reasoning),
    reasoning,
    cache: { read: cacheRead, write: cacheWrite },
    ...(total === undefined ? {} : { total: safe(total) }),
  }
}
