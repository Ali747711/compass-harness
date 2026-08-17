// Ported from opencode (MIT). Source: packages/opencode/src/session/overflow.ts
// https://github.com/anomalyco/opencode — see licenses/opencode-MIT.txt
//
// Diverges from the original: their `usable` reads a reserve override from
// config and an `outputTokenMax` runtime flag, neither of which exists here
// yet. The arithmetic — reserve the output budget, prefer an explicit input
// limit over the whole context window — is unchanged.

import { contextTokens, type Tokens } from "@compass/schema"
import type { ModelLimit } from "../provider/provider"

/**
 * Headroom kept for the reply. A model that can emit 64k tokens needs 64k of
 * its window free at the moment we send, or the request is rejected for a
 * reason that has nothing to do with how much history we packed.
 */
const COMPACTION_BUFFER = 20_000

/**
 * How much of the window a request may actually occupy.
 *
 * Some providers publish a separate input ceiling below the context window; it
 * binds first, so it wins when present.
 */
export function usable(limit: ModelLimit): number {
  if (limit.context === 0) return 0
  const reserved = Math.min(COMPACTION_BUFFER, limit.output)
  return limit.input === undefined ? Math.max(0, limit.context - limit.output) : Math.max(0, limit.input - reserved)
}

/**
 * Whether the last turn's real usage has reached the point where the next
 * request would not fit.
 *
 * Known imprecision, in both directions and deliberately not corrected: the
 * last turn's usage includes reasoning tokens that are never replayed, so it
 * over-counts, and it excludes the next user message, so it under-counts. It is
 * a trigger for a recoverable action, not an accounting figure — being early is
 * cheap and being late costs a failed request.
 *
 * This reads the provider's own count rather than an estimate. The estimate in
 * ../context/pipeline is good enough to decide which old tool output to shrink;
 * it is not good enough to decide that a conversation must be summarized, where
 * being wrong costs either a failed request or a destroyed context.
 */
export function isOverflow(input: { tokens: Tokens | undefined; limit: ModelLimit }): boolean {
  if (input.limit.context === 0) return false
  if (input.tokens === undefined) return false
  return contextTokens(input.tokens) >= usable(input.limit)
}
