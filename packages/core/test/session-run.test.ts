import { MockLanguageModelV4, simulateReadableStream } from "ai/test"
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { layerMemory } from "../src/database/database"
import { layerAllowAll } from "../src/permission/permission"
import { SessionRun, layerWith, toModelMessages } from "../src/session/run"
import { SessionStore, layer as storeLayer } from "../src/session/store"
import { layer as registryLayer } from "../src/tool/registry"
import { make as makeTool } from "../src/tool/tool"

/**
 * Offline tests for the agent loop. No provider is ever contacted: the model is
 * injected through the ResolveModel seam, which exists precisely so this file
 * can exist. `OVERNIGHT.md` forbids live API calls outright.
 */

type Chunk = Parameters<typeof simulateReadableStream>[0]["chunks"][number]

/** A model that replays a fixed script of stream parts, one script per turn. */
function scripted(turns: readonly Chunk[][]) {
  let turn = 0
  const prompts: unknown[] = []
  const doStream = (async (options: { prompt: unknown }) => {
    prompts.push(options.prompt)
    const chunks = turns[Math.min(turn, turns.length - 1)] ?? []
    turn++
    return { stream: simulateReadableStream({ chunks, initialDelayInMs: 0, chunkDelayInMs: 0 }) }
  }) as never
  const model = new MockLanguageModelV4({ doStream })
  return { model, prompts, turns: () => turn }
}

const finish: Chunk = {
  type: "finish",
  finishReason: "stop",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
}

const text = (value: string): Chunk[] => [
  { type: "text-start", id: "t0" },
  { type: "text-delta", id: "t0", delta: value },
  { type: "text-end", id: "t0" },
  finish,
]

const finishWith = (reason: string): Chunk => ({ ...(finish as object), finishReason: reason }) as Chunk

const callTool = (name: string, input: unknown): Chunk[] => [
  { type: "tool-call", toolCallId: "call_1", toolName: name, input: JSON.stringify(input) },
  finishWith("tool-calls"),
]

const echo = makeTool({
  description: "echoes its input back",
  input: Schema.Struct({ value: Schema.String }),
  execute: (input) => Effect.succeed({ title: "echo", output: `echoed:${input.value}` }),
})

const explode = makeTool({
  description: "always fails",
  input: Schema.Struct({}),
  execute: () => Effect.die(new Error("tool blew up")),
})

function harness(turns: readonly Chunk[][]) {
  const script = scripted(turns)
  const directory = mkdtempSync(join(tmpdir(), "run-"))
  const captured: { text: string[]; tools: { name: string; state: string }[] } = { text: [], tools: [] }
  const sink = {
    text: (delta: string) => captured.text.push(delta),
    tool: (event: { name: string; state: string }) => captured.tools.push({ name: event.name, state: event.state }),
  }
  const layers = layerWith(() => script.model as never).pipe(
    Layer.provideMerge(
      registryLayer([
        { name: "echo", tool: echo },
        { name: "explode", tool: explode },
      ]),
    ),
    Layer.provideMerge(storeLayer),
    Layer.provideMerge(layerAllowAll),
    Layer.provideMerge(layerMemory),
  )

  const run = <A, E>(effect: Effect.Effect<A, E, SessionRun | SessionStore>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layers), Effect.scoped) as Effect.Effect<A, E>)

  return { script, directory, captured, sink, run, cleanup: () => rmSync(directory, { recursive: true, force: true }) }
}

/** Runs a test body and cleans up even when an assertion throws. */
async function withHarness(turns: readonly Chunk[][], body: (h: ReturnType<typeof harness>) => Promise<void>) {
  const h = harness(turns)
  try {
    await body(h)
  } finally {
    h.cleanup()
  }
}

const prompt = (h: ReturnType<typeof harness>, message: string) =>
  h.run(
    Effect.gen(function* () {
      const store = yield* SessionStore
      const session = yield* store.create({ title: "t", directory: h.directory })
      const runner = yield* SessionRun
      yield* runner.prompt({ sessionID: session.id, text: message, sink: h.sink })
      return yield* store.messages(session.id)
    }),
  )

describe("toModelMessages", () => {
  test("drops an assistant message with no content rather than sending an empty one", () => {
    const messages = toModelMessages([{ info: { role: "assistant" }, parts: [] }])
    expect(messages).toEqual([])
  })

  test("emits the tool result as its own message, after the call", () => {
    const messages = toModelMessages([
      {
        info: { role: "assistant" },
        parts: [
          {
            id: "prt_1" as never,
            messageID: "msg_1" as never,
            sessionID: "ses_1" as never,
            type: "tool",
            callID: "call_1",
            tool: "echo",
            state: "completed",
            output: "done",
          },
        ],
      },
    ])
    expect(messages.map((m) => m.role)).toEqual(["assistant", "tool"])
  })

  test("omits a tool call that has not settled, so no result is promised", () => {
    const messages = toModelMessages([
      {
        info: { role: "assistant" },
        parts: [
          {
            id: "prt_1" as never,
            messageID: "msg_1" as never,
            sessionID: "ses_1" as never,
            type: "tool",
            callID: "call_1",
            tool: "echo",
            state: "running",
          },
        ],
      },
    ])
    expect(messages.map((m) => m.role)).toEqual(["assistant"])
  })
})

describe("the agent loop", () => {
  test("persists the user turn and the assistant reply", async () => {
    const h = harness([text("hello there")])
    const history = await prompt(h, "hi")

    expect(history.map((entry) => entry.info.role)).toEqual(["user", "assistant"])
    expect(history[1]!.parts[0]).toMatchObject({ type: "text", text: "hello there" })
    h.cleanup()
  })

  test("streams deltas to the sink as they arrive", async () => {
    const h = harness([text("streamed")])
    await prompt(h, "hi")
    expect(h.captured.text.join("")).toBe("streamed")
    h.cleanup()
  })

  test("stops after one provider call when no tool is requested", async () => {
    await withHarness([text("done")], async (h) => {
      await prompt(h, "hi")
      expect(h.script.turns()).toBe(1)
    })
  })

  test("bounds a model that requests a tool forever", async () => {
    // scripted() repeats its last entry, so a single tool-call script drives an
    // otherwise endless loop. MAX_STEPS is the only thing that stops it.
    await withHarness([callTool("echo", { value: "x" })], async (h) => {
      await prompt(h, "go forever")
      expect(h.script.turns()).toBe(40)
    })
  })

  test("runs a requested tool and continues to a second provider call", async () => {
    const h = harness([callTool("echo", { value: "x" }), text("all done")])
    const history = await prompt(h, "hi")

    // One turn to request the tool, one to react to its result.
    expect(h.script.turns()).toBe(2)
    expect(h.captured.tools).toEqual([
      { name: "echo", state: "running" },
      { name: "echo", state: "completed" },
    ])
    const toolParts = history.flatMap((entry) => entry.parts).filter((part) => part.type === "tool")
    expect(toolParts[0]).toMatchObject({ tool: "echo", state: "completed", output: "echoed:x" })
    h.cleanup()
  })

  test("feeds the tool result back to the model on the next turn", async () => {
    const h = harness([callTool("echo", { value: "x" }), text("ok")])
    await prompt(h, "hi")

    // The second request must carry the tool result, or the model is answering blind.
    expect(JSON.stringify(h.script.prompts[1])).toContain("echoed:x")
    h.cleanup()
  })

  test("records a failing tool as an error part and keeps going", async () => {
    const h = harness([callTool("explode", {}), text("recovered")])
    const history = await prompt(h, "hi")

    const toolPart = history.flatMap((entry) => entry.parts).find((part) => part.type === "tool")
    expect(toolPart).toMatchObject({ state: "error" })
    expect(h.captured.tools.at(-1)).toMatchObject({ state: "error" })
    // A tool that dies must not end the turn — the model gets to react.
    expect(h.script.turns()).toBe(2)
    h.cleanup()
  })

  test("reports an unknown tool back to the model instead of crashing", async () => {
    const h = harness([callTool("nonexistent", {}), text("ok")])
    const history = await prompt(h, "hi")

    const toolPart = history.flatMap((entry) => entry.parts).find((part) => part.type === "tool")
    expect(toolPart).toMatchObject({ state: "error" })
    expect(String((toolPart as { error?: string }).error)).toContain("Unknown tool")
    h.cleanup()
  })

  test("rejects malformed tool input as an error the model can correct", async () => {
    const h = harness([callTool("echo", { wrong: 1 }), text("ok")])
    const history = await prompt(h, "hi")

    const toolPart = history.flatMap((entry) => entry.parts).find((part) => part.type === "tool")
    expect(String((toolPart as { error?: string }).error)).toContain("Invalid tool input")
    h.cleanup()
  })

  test("marks the assistant message complete once the turn settles", async () => {
    const h = harness([text("done")])
    const history = await prompt(h, "hi")
    expect(history[1]!.info.timeCompleted).toBeDefined()
    h.cleanup()
  })

  test("rebuilds history from the store rather than keeping it in memory", async () => {
    const h = harness([text("first"), text("second")])
    const history = await h.run(
      Effect.gen(function* () {
        const store = yield* SessionStore
        const session = yield* store.create({ title: "t", directory: h.directory })
        const runner = yield* SessionRun
        yield* runner.prompt({ sessionID: session.id, text: "one", sink: h.sink })
        yield* runner.prompt({ sessionID: session.id, text: "two", sink: h.sink })
        return yield* store.messages(session.id)
      }),
    )

    expect(history.map((entry) => entry.info.role)).toEqual(["user", "assistant", "user", "assistant"])
    // The second request must include the first exchange.
    expect(JSON.stringify(h.script.prompts[1])).toContain("one")
    h.cleanup()
  })
})
