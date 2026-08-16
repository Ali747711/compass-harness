import { messageID, sessionID } from "@compass/schema"
import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { make as makeRegistry } from "../src/tool/registry"
import { MAX_LINES, bound } from "../src/tool/truncate"
import { ToolFailure, make as makeTool, validName } from "../src/tool/tool"

const context = {
  sessionID: sessionID(),
  messageID: messageID(),
  callID: "call_1",
  directory: "/tmp",
  abort: new AbortController().signal,
}

const echo = makeTool({
  description: "echo the given text",
  input: Schema.Struct({ text: Schema.String }),
  execute: (input) => Effect.succeed({ title: "echo", output: input.text }),
})

const boom = makeTool({
  description: "always fails",
  input: Schema.Struct({}),
  execute: () => Effect.fail(new ToolFailure({ message: "deliberate failure" })),
})

const defect = makeTool({
  description: "throws a defect",
  input: Schema.Struct({}),
  execute: () =>
    Effect.sync(() => {
      throw new Error("unexpected explosion")
    }),
})

const run = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect)

describe("tool names", () => {
  test("accepts conventional names and rejects malformed ones", () => {
    expect(validName("read")).toBe(true)
    expect(validName("apply_patch")).toBe(true)
    expect(validName("web-fetch")).toBe(true)
    expect(validName("9lives")).toBe(false)
    expect(validName("has space")).toBe(false)
    expect(validName("")).toBe(false)
  })
})

describe("ToolRegistry", () => {
  test("rejects duplicate registrations at construction", () => {
    expect(() =>
      makeRegistry([
        { name: "echo", tool: echo },
        { name: "echo", tool: echo },
      ]),
    ).toThrow(/Duplicate tool registration/)
  })

  test("rejects invalid tool names at construction", () => {
    expect(() => makeRegistry([{ name: "not valid", tool: echo }])).toThrow(/Invalid tool name/)
  })

  test("settles a successful call", async () => {
    const registry = makeRegistry([{ name: "echo", tool: echo }])
    const settlement = await run(registry.settle({ name: "echo", input: { text: "hi" }, context }))
    expect(settlement.ok).toBe(true)
    if (!settlement.ok) throw new Error("expected success")
    expect(settlement.result.output).toBe("hi")
  })

  test("reports an unknown tool without throwing", async () => {
    const registry = makeRegistry([{ name: "echo", tool: echo }])
    const settlement = await run(registry.settle({ name: "nope", input: {}, context }))
    expect(settlement.ok).toBe(false)
    if (settlement.ok) throw new Error("expected failure")
    expect(settlement.error).toMatch(/Unknown tool/)
  })

  test("turns schema violations into a model-facing error, not a crash", async () => {
    const registry = makeRegistry([{ name: "echo", tool: echo }])
    const settlement = await run(registry.settle({ name: "echo", input: { text: 42 }, context }))
    expect(settlement.ok).toBe(false)
    if (settlement.ok) throw new Error("expected failure")
    expect(settlement.error).toMatch(/Invalid tool input/)
  })

  test("surfaces an expected ToolFailure message", async () => {
    const registry = makeRegistry([{ name: "boom", tool: boom }])
    const settlement = await run(registry.settle({ name: "boom", input: {}, context }))
    expect(settlement.ok).toBe(false)
    if (settlement.ok) throw new Error("expected failure")
    expect(settlement.error).toBe("deliberate failure")
  })

  test("contains a defect instead of killing the turn", async () => {
    const registry = makeRegistry([{ name: "defect", tool: defect }])
    const settlement = await run(registry.settle({ name: "defect", input: {}, context }))
    expect(settlement.ok).toBe(false)
    if (settlement.ok) throw new Error("expected failure")
    expect(settlement.error).toBe("unexpected explosion")
  })

  test("bounds oversized output so a tool cannot opt out of truncation", async () => {
    const flood = makeTool({
      description: "emits far too much",
      input: Schema.Struct({}),
      execute: () =>
        Effect.succeed({
          title: "flood",
          output: Array.from({ length: MAX_LINES + 500 }, (_, i) => `line ${i}`).join("\n"),
        }),
    })
    const registry = makeRegistry([{ name: "flood", tool: flood }])
    const settlement = await run(registry.settle({ name: "flood", input: {}, context }))
    expect(settlement.ok).toBe(true)
    if (!settlement.ok) throw new Error("expected success")
    expect(settlement.result.output.split("\n").length).toBeLessThan(MAX_LINES + 500)
    expect(settlement.result.output).toMatch(/truncated/)
  })

  test("leaves output under the limit untouched", async () => {
    const registry = makeRegistry([{ name: "echo", tool: echo }])
    const settlement = await run(registry.settle({ name: "echo", input: { text: "short" }, context }))
    if (!settlement.ok) throw new Error("expected success")
    expect(settlement.result.output).toBe("short")
  })
})

describe("truncate.bound", () => {
  test("passes through text within limits", () => {
    const result = bound("a\nb\nc")
    expect(result.truncated).toBe(false)
    expect(result.content).toBe("a\nb\nc")
  })

  test("keeps the head and reports how many lines went missing", () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n")
    const result = bound(text, { maxLines: 10 })
    expect(result.truncated).toBe(true)
    if (!result.truncated) throw new Error("expected truncation")
    expect(result.unit).toBe("lines")
    expect(result.removed).toBe(90)
    expect(result.content.startsWith("line 0")).toBe(true)
    expect(result.content).toMatch(/90 lines truncated/)
  })

  test("keeps the tail as well as the head", () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n")
    const result = bound(text, { maxLines: 10 })
    expect(result.truncated).toBe(true)
    expect(result.content.trimEnd().endsWith("line 99")).toBe(true)
  })

  /**
   * The regression that motivated middle-out bounding. Tools put framing last —
   * read's `Use offset=N to continue`, bash's exit code and stderr. Head-only
   * clipping deleted it, so pagination silently broke and failed commands read
   * to the model as clean successes.
   */
  test("preserves trailing framing a tool appended after its content", () => {
    const body = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n")
    const result = bound(`${body}\n\n(Showing lines 1-5000 of 90000. Use offset=5001 to continue.)`)
    expect(result.truncated).toBe(true)
    expect(result.content).toContain("Use offset=5001 to continue.")
    expect(result.content).toContain("line 0")
  })

  test("splits the budget between head and tail", () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n")
    const result = bound(text, { maxLines: 20 })
    expect(result.content).toContain("line 0")
    expect(result.content).toContain("line 99")
    expect(result.content).not.toContain("line 50")
  })

  test("bounds by bytes when the byte limit is reached first", () => {
    const text = Array.from({ length: 50 }, () => "x".repeat(100)).join("\n")
    const result = bound(text, { maxLines: 10_000, maxBytes: 500 })
    expect(result.truncated).toBe(true)
    if (!result.truncated) throw new Error("expected truncation")
    expect(result.unit).toBe("bytes")
    expect(Buffer.byteLength(result.content, "utf-8")).toBeLessThan(Buffer.byteLength(text, "utf-8"))
  })

  test("counts multi-byte characters by bytes, not code points", () => {
    const text = Array.from({ length: 40 }, () => "日".repeat(50)).join("\n")
    const result = bound(text, { maxLines: 10_000, maxBytes: 300 })
    expect(result.truncated).toBe(true)
  })

  test("never splits a surrogate pair when cutting the tail by bytes", () => {
    const text = `${"a".repeat(400)}\n${"🚀".repeat(400)}`
    const result = bound(text, { maxLines: 10_000, maxBytes: 600 })
    expect(result.truncated).toBe(true)
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(result.content)).toBe(false)
  })

  test("degrades to the marker alone when the budget cannot fit content", () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n")
    const result = bound(text, { maxLines: 2 })
    expect(result.truncated).toBe(true)
    expect(result.content).toMatch(/truncated/)
  })
})
