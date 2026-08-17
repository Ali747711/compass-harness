import { APICallError } from "ai"
import { MockLanguageModelV4, simulateReadableStream } from "ai/test"
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { layerMemory } from "../src/database/database"
import { layerAllowAll } from "../src/permission/permission"
import { SessionRun, layerWith } from "../src/session/run"
import { SessionStore, layer as storeLayer } from "../src/session/store"
import { layer as registryLayer } from "../src/tool/registry"
import { make as makeTool } from "../src/tool/tool"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

type Chunk = Parameters<typeof simulateReadableStream>[0]["chunks"][number]
const reason = (unified: string) => ({ unified }) as never
const usage = (i: number, o: number) => ({
  inputTokens: { total: i, noCache: i },
  outputTokens: { total: o, text: o },
})

const echo = makeTool({
  description: "echoes",
  input: Schema.Struct({ value: Schema.String }),
  execute: (input) => Effect.succeed({ title: "echo", output: `echoed:${input.value}` }),
})
const empty = makeTool({
  description: "returns nothing",
  input: Schema.Struct({}),
  execute: () => Effect.succeed({ title: "empty", output: "" }),
})

function validate(prompt: any): string[] {
  const problems: string[] = []
  if (!Array.isArray(prompt)) return ["prompt not array"]
  const body = prompt.filter((m: any) => m.role !== "system")
  if (body.length === 0) problems.push("NO MESSAGES SENT")
  for (let i = 0; i < prompt.length; i++) {
    const m = prompt[i]
    if (m.role === "assistant") {
      if (Array.isArray(m.content) && m.content.length === 0) problems.push(`empty assistant content at ${i}`)
      const calls = (m.content ?? []).filter((p: any) => p.type === "tool-call").map((p: any) => p.toolCallId)
      if (calls.length) {
        const next = prompt[i + 1]
        const results = next && next.role === "tool" ? next.content.map((p: any) => p.toolCallId) : []
        for (const c of calls) if (!results.includes(c)) problems.push(`UNANSWERED tool_use ${c} at ${i}`)
      }
      for (const p of m.content ?? []) {
        if (p.type === "tool-call" && (typeof p.input !== "object" || p.input === null || Array.isArray(p.input)))
          problems.push(`non-object tool input at ${i}: ${JSON.stringify(p.input)}`)
      }
    }
    if (m.role === "tool") {
      const prev = prompt[i - 1]
      const calls = prev && prev.role === "assistant" ? prev.content.filter((p: any) => p.type === "tool-call").map((p: any) => p.toolCallId) : []
      for (const p of m.content) if (!calls.includes(p.toolCallId)) problems.push(`ORPHAN result ${p.toolCallId} at ${i}`)
    }
    if (m.role === "user" && Array.isArray(m.content)) {
      for (const p of m.content) if (p.type === "text" && p.text.length === 0) problems.push(`empty user text at ${i}`)
    }
  }
  return problems
}

function rng(seed: number) {
  let s = seed >>> 0
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296)
}

const BIG = "detail ".repeat(6_000)

function randomTurn(r: () => number, call: number): { chunks: Chunk[]; throwErr?: Error } {
  const pick = r()
  if (pick < 0.08)
    return {
      chunks: [],
      throwErr: new APICallError({
        message: "prompt is too long: 210000 tokens > 200000 maximum",
        url: "https://p.test",
        requestBodyValues: {},
        statusCode: 400,
        isRetryable: false,
        responseHeaders: { "retry-after-ms": "0" },
      }),
    }
  const chunks: Chunk[] = []
  const nBlocks = 1 + Math.floor(r() * 3)
  let toolCount = 0
  for (let b = 0; b < nBlocks; b++) {
    const k = r()
    if (k < 0.3) {
      const id = `t${call}_${b}`
      chunks.push({ type: "text-start", id } as Chunk)
      chunks.push({ type: "text-delta", id, delta: r() < 0.15 ? BIG : `text ${call}.${b}` } as Chunk)
      chunks.push({ type: "text-end", id } as Chunk)
    } else if (k < 0.45) {
      const id = `r${call}_${b}`
      chunks.push({ type: "reasoning-start", id } as Chunk)
      chunks.push({ type: "reasoning-delta", id, delta: `think ${call}.${b}` } as Chunk)
      chunks.push({ type: "reasoning-end", id } as Chunk)
    } else {
      toolCount++
      const id = `c${call}_${b}`
      const kind = r()
      const input =
        kind < 0.25 ? "{bad" : kind < 0.4 ? JSON.stringify({ wrong: 1 }) : kind < 0.5 ? '"juststring"' : kind < 0.6 ? "[1,2]" : JSON.stringify({ value: "v" })
      const name = kind < 0.7 ? "echo" : kind < 0.8 ? "nope" : kind < 0.9 ? "empty" : "echo"
      chunks.push({ type: "tool-input-start", id, toolName: name } as Chunk)
      chunks.push({ type: "tool-call", toolCallId: id, toolName: name, input } as Chunk)
    }
  }
  const fr = toolCount > 0 ? (r() < 0.15 ? "length" : "tool-calls") : r() < 0.1 ? "length" : "stop"
  const big = r() < 0.25
  chunks.push({ type: "finish", finishReason: reason(fr), usage: usage(big ? 150_000 : 100, 50) } as Chunk)
  return { chunks }
}

describe("fuzz", () => {
  test("provider prompts stay structurally valid", async () => {
    const failures: string[] = []
    for (let seed = 1; seed <= 120; seed++) {
      const r = rng(seed)
      const directory = mkdtempSync(join(tmpdir(), "fuzz-"))
      const captured: any[] = []
      let call = 0
      const doStream = (async (options: { prompt: unknown }) => {
        call++
        captured.push(options.prompt)
        const t = randomTurn(r, call)
        if (t.throwErr) throw t.throwErr
        return { stream: simulateReadableStream({ chunks: t.chunks, initialDelayInMs: 0, chunkDelayInMs: 0 }) }
      }) as never
      const model = new MockLanguageModelV4({ doStream })
      const layers = layerWith(() => model as never).pipe(
        Layer.provideMerge(registryLayer([{ name: "echo", tool: echo }, { name: "empty", tool: empty }])),
        Layer.provideMerge(storeLayer),
        Layer.provideMerge(layerAllowAll),
        Layer.provideMerge(layerMemory),
      )
      const sink = { text: () => {}, tool: () => {}, retry: () => {}, compaction: () => {}, incomplete: () => {}, reasoning: () => {} }
      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* SessionStore
          const session = yield* store.create({ title: "t", directory })
          const runner = yield* SessionRun
          for (const p of ["one", "two", "three"]) {
            yield* runner.prompt({ sessionID: session.id, text: p, sink: sink as never }).pipe(Effect.ignore)
          }
        }).pipe(Effect.provide(layers), Effect.scoped),
      )
      rmSync(directory, { recursive: true, force: true })
      captured.forEach((p, i) => {
        const problems = validate(p)
        if (problems.length) failures.push(`seed ${seed} prompt ${i}: ${problems.join("; ")}`)
      })
    }
    if (failures.length) console.log(failures.slice(0, 40).join("\n"))
    expect(failures.length).toBe(0)
  }, 300_000)
})
