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

  test("keeps the tail when asked, which is what shell output needs", () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n")
    const result = bound(text, { maxLines: 10, direction: "tail" })
    expect(result.truncated).toBe(true)
    expect(result.content.trimEnd().endsWith("line 99")).toBe(true)
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
})
