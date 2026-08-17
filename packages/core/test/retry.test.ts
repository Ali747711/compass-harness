import { describe, expect, test } from "bun:test"
import { APICallError } from "ai"
import { classify, describe as explain, isContextOverflow } from "../src/provider/error"
import { ProviderError, resolveModel } from "../src/provider/provider"
import {
  RETRY_INITIAL_DELAY,
  RETRY_MAX_DELAY,
  RETRY_MAX_DELAY_NO_HEADERS,
  delay,
  retryable,
} from "../src/session/retry"

const apiError = (fields: Partial<ConstructorParameters<typeof APICallError>[0]> = {}) =>
  new APICallError({ message: "boom", url: "https://provider.test/v1", requestBodyValues: {}, ...fields })

describe("isContextOverflow", () => {
  test("recognises the phrasings providers actually use", () => {
    expect(isContextOverflow("prompt is too long: 210000 tokens > 200000 maximum")).toBe(true)
    expect(isContextOverflow("This model's maximum context length is 128000 tokens")).toBe(true)
    expect(isContextOverflow("context_length_exceeded")).toBe(true)
    expect(isContextOverflow("400 status code (no body)")).toBe(true)
  })

  /**
   * The exclusions are the load-bearing half. A throttling message that happens
   * to mention limits must stay retryable — classifying it as overflow would
   * turn a two-second pause into a hard failure.
   */
  test("does not mistake a rate limit for an oversized prompt", () => {
    expect(isContextOverflow("Rate limit reached for gpt-4 in organization org-x")).toBe(false)
    expect(isContextOverflow("Too many requests, please slow down")).toBe(false)
    expect(isContextOverflow("Throttling error: rate exceeded")).toBe(false)
  })

  test("stays quiet on ordinary failures", () => {
    expect(isContextOverflow("connection reset by peer")).toBe(false)
    expect(isContextOverflow("invalid x-api-key")).toBe(false)
  })
})

describe("classify", () => {
  test("sorts an oversized request as overflow even when the status is 413 alone", () => {
    expect(classify(apiError({ statusCode: 413, message: "entity too big" })).type).toBe("context_overflow")
  })

  test("reads context_length_exceeded out of the response body", () => {
    const error = apiError({
      statusCode: 400,
      responseBody: JSON.stringify({ error: { code: "context_length_exceeded" } }),
    })
    expect(classify(error).type).toBe("context_overflow")
  })

  test("survives a response body that is not JSON", () => {
    expect(classify(apiError({ statusCode: 500, responseBody: "<html>502 Bad Gateway</html>" })).type).toBe("api_error")
  })

  test("classifies a plain Error without inventing fields", () => {
    const sorted = classify(new Error("socket hang up"))
    expect(sorted.type).toBe("unknown")
    expect(sorted.message).toBe("socket hang up")
  })
})

describe("retryable", () => {
  test("never retries a context overflow — the same input would fail identically", () => {
    expect(retryable(apiError({ statusCode: 400, message: "prompt is too long" }))).toBeUndefined()
  })

  test("retries a 5xx even when the provider forgot to mark it retryable", () => {
    expect(retryable(apiError({ statusCode: 503, isRetryable: false, message: "upstream unavailable" }))).toBeTruthy()
  })

  test("gives up on a rejected key", () => {
    expect(retryable(apiError({ statusCode: 401, isRetryable: false, message: "invalid x-api-key" }))).toBeUndefined()
  })

  test("retries a rate limit and carries its headers through for the backoff", () => {
    const result = retryable(
      apiError({ statusCode: 429, isRetryable: true, message: "rate limit", responseHeaders: { "retry-after": "7" } }),
    )
    expect(result?.headers).toEqual({ "retry-after": "7" })
  })

  test("recognises a transient network failure that carries no status at all", () => {
    expect(retryable(new Error("fetch failed: ECONNRESET"))?.message).toContain("ECONNRESET")
  })

  test("rewrites an overload message into something a person can read", () => {
    expect(retryable(apiError({ statusCode: 529, isRetryable: true, message: "Overloaded" }))?.message).toBe(
      "Provider is overloaded",
    )
  })

  test("does not retry a plain bad request", () => {
    expect(retryable(apiError({ statusCode: 400, isRetryable: false, message: "unknown field 'foo'" }))).toBeUndefined()
  })
})

describe("delay", () => {
  /** A provider that told us when to come back is obeyed exactly, not approximated. */
  test("prefers retry-after-ms over its own arithmetic", () => {
    expect(delay(1, { "retry-after-ms": "1500" }, 0)).toBe(1500)
  })

  test("reads retry-after as seconds", () => {
    expect(delay(1, { "retry-after": "3" }, 0)).toBe(3000)
  })

  test("reads retry-after as an HTTP date", () => {
    const when = new Date(Date.now() + 5_000).toUTCString()
    const waited = delay(1, { "retry-after": when }, 0)
    expect(waited).toBeGreaterThan(3_000)
    expect(waited).toBeLessThanOrEqual(5_000)
  })

  test("backs off exponentially when the provider said nothing", () => {
    expect(delay(1, undefined, 0)).toBe(RETRY_INITIAL_DELAY)
    expect(delay(2, undefined, 0)).toBe(RETRY_INITIAL_DELAY * 2)
    expect(delay(3, undefined, 0)).toBe(RETRY_INITIAL_DELAY * 4)
  })

  test("adds jitter so a fleet of clients does not retry in lockstep", () => {
    expect(delay(1, undefined, 1)).toBeGreaterThan(delay(1, undefined, 0))
  })

  /**
   * A guess that overshoots only wastes the user's time, so an unguided backoff
   * is capped far lower than an instructed one.
   */
  test("caps an unguided backoff at 30s but lets an instructed wait run long", () => {
    expect(delay(20, undefined, 1)).toBe(RETRY_MAX_DELAY_NO_HEADERS)
    expect(delay(1, { "retry-after": "3600" }, 0)).toBe(3_600_000)
  })

  test("clamps past the point where setTimeout would overflow and fire instantly", () => {
    expect(delay(1, { "retry-after-ms": "99999999999" }, 0)).toBe(RETRY_MAX_DELAY)
  })

  test("ignores an unparseable header rather than waiting NaN", () => {
    expect(delay(1, { "retry-after": "whenever" }, 0)).toBe(RETRY_INITIAL_DELAY)
  })
})

describe("describe", () => {
  test("reduces a rejected key to one line naming the variable to check", () => {
    const explained = explain(apiError({ statusCode: 401, message: "invalid x-api-key\n  at foo\n  at bar" }))
    expect(explained.message).toContain("ANTHROPIC_API_KEY")
    expect(explained.message).not.toContain("at foo")
  })

  test("says what to do about an overflow instead of just restating it", () => {
    expect(explain(apiError({ statusCode: 400, message: "prompt is too long" })).message).toContain("compaction")
  })
})

describe("failures that carry no message", () => {
  /**
   * The worst possible terminal output is none. A missing API key used to exit 1
   * having printed a blank line, because ProviderError carried its text in a
   * field called `reason` while every layer downstream read `.message` — which
   * Effect leaves empty unless the prop is literally named `message`.
   */
  test("a provider error states what is wrong", () => {
    const error = new ProviderError({ providerID: "anthropic", message: "ANTHROPIC_API_KEY is not set." })
    expect(error.message).toContain("ANTHROPIC_API_KEY")
    expect(explain(error).message).toContain("ANTHROPIC_API_KEY")
  })

  test("a missing key is reported rather than thrown blank", () => {
    const key = process.env["ANTHROPIC_API_KEY"]
    delete process.env["ANTHROPIC_API_KEY"]
    try {
      expect(() => resolveModel({ providerID: "anthropic", modelID: "claude-sonnet-4-5" })).toThrow(
        /ANTHROPIC_API_KEY is not set/,
      )
    } finally {
      if (key !== undefined) process.env["ANTHROPIC_API_KEY"] = key
    }
  })

  test("an unknown provider names the ones that exist", () => {
    expect(() => resolveModel({ providerID: "banana", modelID: "x" })).toThrow(/anthropic, openai/)
  })

  /** Never propagate "" — it reaches the terminal and looks like success. */
  test("classify substitutes something legible for an empty message", () => {
    expect(classify(new Error("")).message.length).toBeGreaterThan(0)
    expect(explain(new Error("")).message.length).toBeGreaterThan(0)
  })

  test("classify uses the tag when a tagged error has no message", () => {
    class Silent extends ProviderError {}
    const quiet = Object.assign(new Silent({ providerID: "p", message: "" }), {})
    expect(classify(quiet).message).toContain("ProviderError")
  })
})

describe("surfacing what the provider actually said", () => {
  /**
   * A 401 and a spent balance both arrive as a 4xx, and only the response body
   * tells them apart. Collapsing both to "check your key" sends people to
   * inspect something that was never wrong.
   */
  test("prefers the provider's sentence over our generic one", () => {
    const spent = apiError({
      statusCode: 400,
      isRetryable: false,
      message: "Bad Request",
      responseBody: JSON.stringify({
        error: { type: "invalid_request_error", message: "Your credit balance is too low to access the API" },
      }),
    })
    expect(explain(spent).message).toContain("credit balance is too low")
  })

  test("names the error type when the message does not already", () => {
    const auth = apiError({
      statusCode: 401,
      isRetryable: false,
      message: "Unauthorized",
      responseBody: JSON.stringify({ error: { type: "authentication_error", message: "invalid x-api-key" } }),
    })
    const explained = explain(auth).message
    expect(explained).toContain("invalid x-api-key")
    expect(explained).toContain("authentication_error")
    // And still says what to do about it.
    expect(explained).toContain("ANTHROPIC_API_KEY")
  })

  test("falls back to our own wording when the body says nothing useful", () => {
    const bare = apiError({ statusCode: 401, isRetryable: false, message: "API key is invalid." })
    expect(explain(bare).message).toContain("API key is invalid.")
    expect(explain(bare).message).toContain("ANTHROPIC_API_KEY")
  })

  test("survives a body that is HTML from a proxy rather than provider JSON", () => {
    const proxied = apiError({ statusCode: 403, isRetryable: false, message: "Forbidden", responseBody: "<html>" })
    expect(explain(proxied).message).toContain("Forbidden")
  })
})
