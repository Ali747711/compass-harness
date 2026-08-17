// Ported from opencode (MIT).
// Sources: packages/llm/src/provider-error.ts:4-38 (context-overflow patterns),
//          packages/opencode/src/provider/error.ts:165-186 (classification shape)
// https://github.com/anomalyco/opencode — see licenses/opencode-MIT.txt
//
// Diverges from the original: opencode normalizes provider failures into their
// own `SessionV1.APIError` schema first. We classify the AI SDK's `APICallError`
// directly, because their schema is a field-for-field copy of it — statusCode,
// isRetryable, responseHeaders, responseBody — and the extra hop buys nothing
// until there is a second provider protocol to normalize.

import { APICallError } from "ai"

/**
 * Messages that mean "your input did not fit", collected across providers.
 *
 * Every provider words this differently and none of them use a stable code, so
 * the only portable signal is the prose. Copied verbatim rather than
 * paraphrased: each pattern is a bug report someone already filed.
 */
const OVERFLOW_PATTERNS = [
  /prompt is too long/i,
  /request_too_large/i,
  /input is too long for requested model/i,
  /exceeds the context window/i,
  /exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i,
  /input token count.*exceeds the maximum/i,
  /tokens in request more than max tokens allowed/i,
  /maximum prompt length is \d+/i,
  /reduce the length of the messages/i,
  /maximum context length is \d+ tokens/i,
  /exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i,
  /input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i,
  /exceeds the limit of \d+/i,
  /exceeds the available context size/i,
  /greater than the context length/i,
  /context window exceeds limit/i,
  /exceeded model token limit/i,
  /context[_ ]length[_ ]exceeded/i,
  /request entity too large/i,
  /context length is only \d+ tokens/i,
  /input length.*exceeds.*context length/i,
  /prompt too long; exceeded (?:max )?context length/i,
  /too large for model with \d+ maximum context length/i,
  /prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i,
  /model_context_window_exceeded/i,
  /too many tokens/i,
  /token limit exceeded/i,
]

/**
 * Load-bearing. A throttling message can read as an overflow one — "too many
 * requests" trips nothing here, but provider prose wanders, and misclassifying
 * a rate limit as overflow turns a retryable pause into a hard failure.
 */
const OVERFLOW_EXCLUSIONS = [/^(throttling error|service unavailable):/i, /rate limit/i, /too many requests/i]

export const isContextOverflow = (message: string) =>
  !OVERFLOW_EXCLUSIONS.some((pattern) => pattern.test(message)) &&
  (OVERFLOW_PATTERNS.some((pattern) => pattern.test(message)) ||
    // A bare 400/413 with no body is overwhelmingly an oversized request.
    /^4(00|13)\s*(status code)?\s*\(no body\)/i.test(message))

export type Classified =
  | {
      /** The input did not fit. Retrying sends the same oversized input; compaction is the only fix. */
      readonly type: "context_overflow"
      readonly message: string
      readonly responseBody?: string
    }
  | {
      readonly type: "api_error"
      readonly message: string
      readonly statusCode?: number
      readonly isRetryable: boolean
      readonly responseHeaders?: Record<string, string>
      readonly responseBody?: string
    }
  | { readonly type: "unknown"; readonly message: string }

function parseBody(value: string | undefined): { error?: { code?: unknown } } | undefined {
  if (typeof value !== "string") return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === "object" && parsed !== null ? (parsed as { error?: { code?: unknown } }) : undefined
  } catch {
    return undefined
  }
}

/** Sorts a thrown provider failure into the three cases the loop treats differently. */
export function classify(cause: unknown): Classified {
  if (APICallError.isInstance(cause)) {
    const body = parseBody(cause.responseBody)
    if (isContextOverflow(cause.message) || cause.statusCode === 413 || body?.error?.code === "context_length_exceeded")
      return { type: "context_overflow", message: cause.message, ...maybe("responseBody", cause.responseBody) }

    return {
      type: "api_error",
      message: cause.message,
      isRetryable: cause.isRetryable,
      ...maybe("statusCode", cause.statusCode),
      ...maybe("responseHeaders", cause.responseHeaders),
      ...maybe("responseBody", cause.responseBody),
    }
  }

  // An Error with an empty message is worse than no error at all: it travels the
  // whole way to the terminal and prints a blank line. Fall back through what is
  // actually available rather than propagating "".
  const raw = cause instanceof Error ? cause.message : String(cause)
  const message = raw.trim().length > 0 ? raw : describeEmpty(cause)
  if (isContextOverflow(message)) return { type: "context_overflow", message }
  return { type: "unknown", message }
}

/** Last resort when a thrown value carries no usable message of its own. */
function describeEmpty(cause: unknown): string {
  const named = cause as { _tag?: unknown; name?: unknown }
  const label = typeof named?._tag === "string" ? named._tag : typeof named?.name === "string" ? named.name : undefined
  return label === undefined || label === "Error" ? "The provider call failed without reporting a reason." : label
}

/** `exactOptionalPropertyTypes` rejects an explicit `undefined`, so omit the key instead. */
const maybe = <K extends string, V>(key: K, value: V | undefined) =>
  (value === undefined ? {} : { [key]: value }) as { [P in K]?: V }

/**
 * Pulls the useful line out of a provider failure without dragging the request
 * body along.
 *
 * An invalid key used to print ~60 lines: a stack trace through the SDK plus
 * the full request — model settings, system prompt, every message. The useful
 * fact was buried in the middle.
 */
export function describe(cause: unknown): { message: string; status?: number } {
  const sorted = classify(cause)
  const detail = sorted.message.split("\n")[0] ?? sorted.message

  if (sorted.type === "context_overflow")
    return { message: `${detail} The conversation no longer fits; compaction is required.` }
  if (sorted.type !== "api_error") return { message: detail }

  const status = sorted.statusCode
  if (status === 401 || status === 403)
    return {
      message: `${detail} Check ANTHROPIC_API_KEY (or OPENAI_API_KEY for an openai/ model).`,
      ...maybe("status", status),
    }
  if (status === 429) return { message: `${detail} The provider is rate limiting; retry shortly.`, status }
  return { message: detail, ...maybe("status", status) }
}
