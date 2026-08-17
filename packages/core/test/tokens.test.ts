import { contextTokens } from "@compass/schema"
import { describe, expect, test } from "bun:test"
import type { LanguageModelUsage } from "ai"
import { modelLimit } from "../src/provider/provider"
import { toTokens } from "../src/provider/usage"
import { isOverflow, usable } from "../src/session/overflow"

/** The flattened shape that reaches `fullStream`, not the nested provider one. */
const usage = (fields: {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}): LanguageModelUsage => ({
  inputTokens: fields.inputTokens,
  outputTokens: fields.outputTokens,
  totalTokens: fields.totalTokens,
  inputTokenDetails: {
    noCacheTokens: undefined,
    cacheReadTokens: fields.cacheReadTokens,
    cacheWriteTokens: fields.cacheWriteTokens,
  },
  outputTokenDetails: { textTokens: undefined, reasoningTokens: fields.reasoningTokens },
})

describe("toTokens", () => {
  /**
   * The trap this mapping exists for. The AI SDK folds cache reads and writes
   * into `inputTokens`, so storing both as-is counts them twice and every
   * cached turn reads as roughly double its real size.
   */
  test("does not count cached input twice", () => {
    const tokens = toTokens(
      usage({
        inputTokens: 10_000,
        cacheReadTokens: 7_000,
        cacheWriteTokens: 1_000,
        outputTokens: 500,
      }),
    )

    expect(tokens?.input).toBe(2_000)
    expect(tokens?.cache).toEqual({ read: 7_000, write: 1_000 })
    // Re-adding the split parts reconstructs what the provider actually charged.
    expect(contextTokens(tokens!)).toBe(10_500)
  })

  test("separates reasoning out of the output count", () => {
    const tokens = toTokens(usage({ inputTokens: 100, outputTokens: 900, reasoningTokens: 400 }))
    expect(tokens?.output).toBe(500)
    expect(tokens?.reasoning).toBe(400)
    expect(contextTokens(tokens!)).toBe(1_000)
  })

  test("prefers the provider's own total over our arithmetic", () => {
    const tokens = toTokens(usage({ inputTokens: 100, outputTokens: 100, totalTokens: 250 }))
    expect(contextTokens(tokens!)).toBe(250)
  })

  /**
   * opencode's fallback sum omits reasoning (session/overflow.ts:32). Their
   * `total` is nearly always present so it rarely shows, but a reasoning-heavy
   * turn on a provider that reports no total would read as far smaller than it
   * was — and undercounting is the one direction this must never fail in.
   */
  test("includes reasoning in the fallback sum when no total is reported", () => {
    const tokens = toTokens(usage({ inputTokens: 100, outputTokens: 900, reasoningTokens: 800 }))
    expect(tokens?.total).toBeUndefined()
    expect(contextTokens(tokens!)).toBe(1_000)
  })

  test("reports nothing rather than a row of zeroes when the provider said nothing", () => {
    expect(toTokens(undefined)).toBeUndefined()
    expect(toTokens(usage({}))).toBeUndefined()
  })

  test("never goes negative when a provider contradicts itself", () => {
    const tokens = toTokens(usage({ inputTokens: 100, cacheReadTokens: 5_000 }))
    expect(tokens?.input).toBe(0)
  })
})

describe("modelLimit", () => {
  test("resolves a dated model id to its family", () => {
    expect(modelLimit({ providerID: "anthropic", modelID: "claude-sonnet-4-5-20260101" }).context).toBe(200_000)
  })

  /** Guessing high means finding out mid-conversation, as a failed request. */
  test("assumes the smaller window for a model it does not know", () => {
    expect(modelLimit({ providerID: "anthropic", modelID: "claude-nonesuch-9" }).context).toBe(128_000)
  })
})

describe("usable / isOverflow", () => {
  test("reserves the output budget out of the context window", () => {
    expect(usable({ context: 200_000, output: 64_000 })).toBe(136_000)
  })

  test("prefers an explicit input ceiling, which binds before the window does", () => {
    expect(usable({ context: 1_000_000, output: 32_000, input: 200_000 })).toBe(180_000)
  })

  test("reports no overflow when the provider never told us anything", () => {
    expect(isOverflow({ tokens: undefined, limit: { context: 200_000, output: 64_000 } })).toBe(false)
  })

  test("stays quiet while the conversation still fits", () => {
    const tokens = toTokens(usage({ inputTokens: 50_000, outputTokens: 1_000 }))
    expect(isOverflow({ tokens, limit: { context: 200_000, output: 64_000 } })).toBe(false)
  })

  test("fires once real usage reaches the usable budget", () => {
    const tokens = toTokens(usage({ inputTokens: 140_000, outputTokens: 1_000 }))
    expect(isOverflow({ tokens, limit: { context: 200_000, output: 64_000 } })).toBe(true)
  })

  /** The cached case is exactly where double-counting would have compacted early. */
  test("does not fire on a heavily cached turn that genuinely fits", () => {
    const tokens = toTokens(usage({ inputTokens: 60_000, cacheReadTokens: 55_000, outputTokens: 500 }))
    expect(isOverflow({ tokens, limit: { context: 200_000, output: 64_000 } })).toBe(false)
  })
})
