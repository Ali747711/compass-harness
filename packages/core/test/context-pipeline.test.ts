import type { ModelMessage } from "ai"
import { describe, expect, test } from "bun:test"
import {
  PROTECT_TOKENS,
  TRIGGER_TOKENS,
  estimateMessages,
  estimateTokens,
  prune,
  prunableTokens,
  shouldCompact,
} from "../src/context/pipeline"

/** Small limits keep the fixtures readable; the defaults are exercised separately. */
const limits = { triggerTokens: 100, protectTokens: 200, resultChars: 50 }

function turn(index: number, resultChars: number): ModelMessage[] {
  return [
    { role: "user", content: `question ${index}` },
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: `call_${index}`, toolName: "bash", input: { command: "ls" } }],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: `call_${index}`,
          toolName: "bash",
          output: { type: "text", value: "o".repeat(resultChars) },
        },
      ],
    },
    { role: "assistant", content: [{ type: "text", text: `answer ${index}` }] },
  ]
}

function history(turns: number, resultChars: number) {
  return Array.from({ length: turns }, (_, i) => turn(i, resultChars)).flat()
}

/** Every tool-call id must still have exactly one matching tool-result id. */
function pairing(messages: readonly ModelMessage[]) {
  const calls: string[] = []
  const results: string[] = []
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (typeof part !== "object" || part === null) continue
      if (part.type === "tool-call") calls.push(part.toolCallId)
      if (part.type === "tool-result") results.push(part.toolCallId)
    }
  }
  return { calls, results }
}

function resultValues(messages: readonly ModelMessage[]) {
  const values: string[] = []
  for (const message of messages) {
    if (message.role !== "tool" || !Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (typeof part === "object" && part !== null && part.type === "tool-result") {
        values.push(String((part.output as { value: unknown }).value))
      }
    }
  }
  return values
}

describe("estimation", () => {
  test("is length over four, never a provider call", () => {
    expect(estimateTokens("")).toBe(0)
    expect(estimateTokens("abcd")).toBe(1)
    expect(estimateTokens("abcde")).toBe(2)
  })

  test("counts tool-result text, which is the thing that actually grows", () => {
    const withResult = estimateMessages(turn(0, 4000))
    const withoutResult = estimateMessages(turn(0, 0))
    expect(withResult - withoutResult).toBeGreaterThan(900)
  })
})

describe("shouldCompact", () => {
  test("is false for a short history", () => {
    expect(shouldCompact(history(1, 10), limits)).toBe(false)
  })

  test("is true once the estimate passes the trigger", () => {
    expect(shouldCompact(history(20, 400), limits)).toBe(true)
  })
})

describe("prune", () => {
  test("leaves a history under the threshold completely untouched", () => {
    const input = history(1, 10)
    const outcome = prune(input, limits)
    expect(outcome.pruned).toBe(0)
    expect(outcome.charsSaved).toBe(0)
    expect(outcome.messages).toEqual(input)
  })

  test("shortens old tool results once over the threshold", () => {
    const outcome = prune(history(30, 400), limits)
    expect(outcome.pruned).toBeGreaterThan(0)
    expect(outcome.charsSaved).toBeGreaterThan(0)
  })

  test("protects the most recent window", () => {
    const outcome = prune(history(30, 400), limits)
    const values = resultValues(outcome.messages)
    // The newest result is inside the protected window and keeps its length.
    expect(values.at(-1)!.length).toBe(400)
    // The oldest is outside it and was shortened.
    expect(values[0]!.length).toBeLessThan(400)
  })

  test("marks what it removed rather than truncating silently", () => {
    const outcome = prune(history(30, 400), limits)
    expect(resultValues(outcome.messages)[0]).toContain("pruned to save context")
    expect(resultValues(outcome.messages)[0]).toContain("characters removed")
  })

  test("never orphans a tool call from its result", () => {
    const before = pairing(history(30, 400))
    const after = pairing(prune(history(30, 400), limits).messages)
    expect(after.calls).toEqual(before.calls)
    expect(after.results).toEqual(before.results)
  })

  test("preserves message count, order and roles", () => {
    const input = history(30, 400)
    const outcome = prune(input, limits)
    expect(outcome.messages).toHaveLength(input.length)
    expect(outcome.messages.map((m) => m.role)).toEqual(input.map((m) => m.role))
  })

  test("does not touch user or assistant text, only tool results", () => {
    const input = history(30, 400)
    const outcome = prune(input, limits)
    for (const [index, message] of input.entries()) {
      if (message.role === "tool") continue
      expect(outcome.messages[index]).toEqual(message)
    }
  })

  test("keeps an error result an error result", () => {
    const input: ModelMessage[] = [
      ...history(30, 400),
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_err",
            toolName: "bash",
            output: { type: "error-text", value: "e".repeat(400) },
          },
        ],
      },
    ]
    // Put the error early so it falls outside the protected window.
    const reordered = [input.at(-1)!, ...input.slice(0, -1)]
    const outcome = prune(reordered, limits)
    const first = outcome.messages[0]!
    const part = (first.content as { output: { type: string; value: string } }[])[0]!
    expect(part.output.type).toBe("error-text")
    expect(part.output.value).toContain("pruned to save context")
  })

  test("leaves a short old result alone rather than adding a pointless marker", () => {
    const outcome = prune([...history(1, 5), ...history(30, 400)], limits)
    expect(resultValues(outcome.messages)[0]).toBe("ooooo")
  })

  test("is idempotent: pruning twice changes nothing the second time", () => {
    const once = prune(history(30, 400), limits)
    const twice = prune(once.messages, limits)
    expect(twice.messages).toEqual(once.messages)
    expect(twice.pruned).toBe(0)
  })

  test("does not mutate its input", () => {
    const input = history(30, 400)
    const snapshot = structuredClone(input)
    prune(input, limits)
    expect(input).toEqual(snapshot)
  })
})

/**
 * Regressions for the review findings. Each of these passed against the broken
 * implementation, which is why they exist.
 */
describe("review regressions", () => {
  test("the trigger is reachable at the shipped defaults", () => {
    // Both thresholds used to measure the whole conversation, so a protect
    // window larger than the trigger meant nothing was ever pruned.
    const big = history(400, 4000)
    expect(prunableTokens(big)).toBeGreaterThan(TRIGGER_TOKENS)
    expect(shouldCompact(big)).toBe(true)
    expect(prune(big).pruned).toBeGreaterThan(0)
  })

  test("defaults leave a modest conversation alone", () => {
    const small = history(3, 400)
    expect(shouldCompact(small)).toBe(false)
    expect(prune(small).pruned).toBe(0)
  })

  test("PROTECT larger than TRIGGER no longer disables pruning", () => {
    expect(PROTECT_TOKENS).toBeGreaterThan(TRIGGER_TOKENS)
    expect(prune(history(400, 4000)).pruned).toBeGreaterThan(0)
  })

  test("the newest message stays protected even when it alone exceeds the window", () => {
    // The boundary used to stay at messages.length, protecting nothing, so the
    // result the assistant had just produced was truncated before it was used.
    const huge = turn(0, 8000)
    const outcome = prune(huge, { triggerTokens: 1, protectTokens: 200, resultChars: 50 })
    expect(outcome.pruned).toBe(0)
    expect(resultValues(outcome.messages)[0]!.length).toBe(8000)
  })

  test("genuine output containing the sentinel is still pruned", () => {
    // A bare substring check exempted such output from the cap forever. A grep
    // over the pipeline source produces exactly this.
    const poisoned: ModelMessage[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_p",
            toolName: "grep",
            output: {
              type: "text",
              value: `const S = "[older tool result pruned to save context:"\n${"z".repeat(4000)}`,
            },
          },
        ],
      },
      ...history(30, 400),
    ]
    const outcome = prune(poisoned, limits)
    expect(resultValues(outcome.messages)[0]!.length).toBeLessThan(500)
  })

  test("leaves structured tool outputs untouched rather than corrupting them", () => {
    // Rewriting `value` to a string while keeping type "json"/"content"
    // produces a shape the provider rejects.
    const structured: ModelMessage[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_j",
            toolName: "api",
            output: { type: "json", value: { blob: "y".repeat(4000) } },
          },
        ],
      },
      ...history(30, 400),
    ]
    const outcome = prune(structured, limits)
    const part = (outcome.messages[0]!.content as { output: { type: string; value: unknown } }[])[0]!
    expect(part.output.type).toBe("json")
    expect(typeof part.output.value).toBe("object")
  })

  test("an empty history is a no-op", () => {
    expect(prune([], limits)).toEqual({ messages: [], pruned: 0, charsSaved: 0 })
  })
})
