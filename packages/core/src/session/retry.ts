// Ported from opencode (MIT). Source: packages/opencode/src/session/retry.ts
// https://github.com/anomalyco/opencode — see licenses/opencode-MIT.txt
//
// Diverges from the original in two ways. Their OpenCode Go branches
// (FreeUsageLimitError, GoUsageLimitError, the subscribe upsell) are dropped —
// that is their commercial service, not a general retry concern. And the error
// is the AI SDK's `APICallError` classified by ../provider/error rather than
// their normalized `SessionV1.APIError`.
//
// The backoff arithmetic, the Retry-After handling, and the retryable-message
// patterns are verbatim.

import { Cause, Clock, Duration, Effect, Schedule } from "effect"
import { classify } from "../provider/error"

export const RETRY_INITIAL_DELAY = 2000
export const RETRY_BACKOFF_FACTOR = 2
export const RETRY_JITTER_FACTOR = 0.25
export const RETRY_MAX_DELAY_NO_HEADERS = 30_000
/** Max 32-bit signed integer — beyond this `setTimeout` fires immediately. */
export const RETRY_MAX_DELAY = 2_147_483_647
export const RETRY_MAX_RETRIES = 5

/**
 * Failures worth trying again. Providers are inconsistent about `isRetryable`
 * and about status codes, so the message is the fallback signal — and in
 * practice the one that fires most.
 */
const RETRYABLE_MESSAGE_PATTERNS = [
  /429|500|502|503|504|524/i,
  /rate increased too quickly|rate limit|rate-limit|rate_limit|too many requests/i,
  /overloaded|service unavailable|service_unavailable|service-unavailable|internal error|internal_error|internal server error|server error|server_error|server-error|provider returned error|provider_returned_error|provider-returned-error/i,
  /terminated|fetch failed|failed to fetch|network error|upstream connect|connection error|connection refused|connection lost|socket connection was closed|socket hang up|reset before headers|getaddrinfo|enotfound|eai_again|econnrefused|econnreset|etimedout/i,
  /^timeout$|\b(?:request|response|connection|network|stream|read) (?:timeout|timed out|time out)\b/i,
  /try your request again|retry your request|resource exhausted|resource_exhausted/i,
]

const matchesRetryableMessage = (value: unknown) =>
  typeof value === "string" && RETRYABLE_MESSAGE_PATTERNS.some((pattern) => pattern.test(value))

const cap = (ms: number) => Math.min(ms, RETRY_MAX_DELAY)

const exponential = (attempt: number, random: number) => {
  const base = RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1)
  return Math.ceil(base + base * RETRY_JITTER_FACTOR * random)
}

export interface RetryHeaders {
  readonly [key: string]: string | undefined
}

/**
 * How long to wait before attempt `attempt` (1-based).
 *
 * A provider that told us when to come back is obeyed exactly — `retry-after-ms`
 * first, then `retry-after` as seconds, then as an HTTP date. Only when it said
 * nothing do we guess, and a guess is capped far lower (30s) than an instruction
 * is, because a guess that overshoots just wastes the user's time.
 *
 * `random` is a parameter so the jitter is testable.
 */
export function delay(attempt: number, headers?: RetryHeaders, random = Math.random()) {
  if (headers) {
    const retryAfterMs = headers["retry-after-ms"]
    if (retryAfterMs !== undefined) {
      const parsed = Number.parseFloat(retryAfterMs)
      if (!Number.isNaN(parsed)) return cap(parsed)
    }

    const retryAfter = headers["retry-after"]
    if (retryAfter !== undefined) {
      const seconds = Number.parseFloat(retryAfter)
      if (!Number.isNaN(seconds)) return cap(Math.ceil(seconds * 1000))
      const absolute = Date.parse(retryAfter) - Date.now()
      if (!Number.isNaN(absolute) && absolute > 0) return cap(Math.ceil(absolute))
    }

    return cap(exponential(attempt, random))
  }

  return cap(Math.min(exponential(attempt, random), RETRY_MAX_DELAY_NO_HEADERS))
}

export interface Retryable {
  readonly message: string
  readonly headers?: Record<string, string>
}

/**
 * Whether this failure is worth another attempt, and what to tell the user
 * while waiting. `undefined` means give up now.
 */
export function retryable(cause: unknown): Retryable | undefined {
  const sorted = classify(cause)

  // Retrying an overflow re-sends the same oversized input and fails the same
  // way five more times, each attempt billed. Compaction is the only fix.
  if (sorted.type === "context_overflow") return undefined

  if (sorted.type === "api_error") {
    const status = sorted.statusCode
    // 5xx is a transient server failure and is always worth retrying, even when
    // the provider SDK neglects to mark it retryable.
    const serverError = status !== undefined && status >= 500
    if (
      !sorted.isRetryable &&
      !serverError &&
      !matchesRetryableMessage(sorted.message) &&
      !matchesRetryableMessage(sorted.responseBody)
    )
      return undefined

    const message = sorted.message.includes("Overloaded") ? "Provider is overloaded" : sorted.message
    return sorted.responseHeaders === undefined ? { message } : { message, headers: sorted.responseHeaders }
  }

  const lower = sorted.message.toLowerCase()
  if (lower.includes("too_many_requests")) return { message: "Too Many Requests" }
  if (lower.includes("exhausted") || lower.includes("unavailable")) return { message: "Provider is overloaded" }
  if (matchesRetryableMessage(sorted.message)) return { message: sorted.message }
  return undefined
}

export interface Attempt {
  readonly attempt: number
  readonly message: string
  /** Epoch milliseconds at which the next attempt is due, for a countdown. */
  readonly next: number
}

/**
 * An Effect `Schedule` that retries transient provider failures with the
 * backoff above, reporting each wait through `onRetry` so the UI can say what
 * it is waiting for instead of appearing to hang.
 *
 * Built as a Schedule rather than a hand-rolled loop so it composes with
 * interruption: aborting a turn cancels a pending backoff sleep immediately.
 */
export function policy(onRetry: (attempt: Attempt) => Effect.Effect<void>) {
  return Schedule.fromStepWithMetadata(
    Effect.succeed((meta: Schedule.InputMetadata<unknown>) => {
      const retry = retryable(meta.input)
      if (!retry) return Cause.done(meta.attempt)
      if (meta.attempt > RETRY_MAX_RETRIES) return Cause.done(meta.attempt)
      return Effect.gen(function* () {
        const wait = delay(meta.attempt, retry.headers)
        const now = yield* Clock.currentTimeMillis
        yield* onRetry({ attempt: meta.attempt, message: retry.message, next: now + wait })
        return [meta.attempt, Duration.millis(wait)] as [number, Duration.Duration]
      })
    }),
  )
}
