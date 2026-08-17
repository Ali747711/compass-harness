import { APICallError } from "ai"
import { MockLanguageModelV4, simulateReadableStream } from "ai/test"
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { layerMemory } from "../src/database/database"
import { layerAllowAll } from "../src/permission/permission"
import { RETRY_MAX_RETRIES } from "../src/session/retry"
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

/**
 * A model that fails its first `failures` calls before replaying `after`.
 *
 * Every failure carries `retry-after-ms: 0`, which is a real header a provider
 * can send and which makes `delay()` return 0 — so the retry schedule is
 * exercised in full at wall-clock speed rather than being mocked out.
 */
function flaky(failures: number, error: () => Error, after: Chunk[]) {
  let calls = 0
  const doStream = (async () => {
    calls++
    if (calls <= failures) throw error()
    return { stream: simulateReadableStream({ chunks: after, initialDelayInMs: 0, chunkDelayInMs: 0 }) }
  }) as never
  return { model: new MockLanguageModelV4({ doStream }), calls: () => calls }
}

const transient = (message: string, fields: Record<string, unknown> = {}) =>
  new APICallError({
    message,
    url: "https://provider.test/v1",
    requestBodyValues: {},
    isRetryable: true,
    responseHeaders: { "retry-after-ms": "0" },
    ...fields,
  })

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

/**
 * Provider-level usage is nested (`LanguageModelV3Usage`); the SDK flattens it
 * into the `inputTokenDetails`/`outputTokenDetails` shape that reaches
 * `fullStream`. Mock chunks must use the nested form or the flattening throws.
 */
const usage = (input: { in?: number; out?: number; cacheRead?: number; cacheWrite?: number; reasoning?: number }) => ({
  inputTokens: {
    total: input.in,
    noCache: input.in === undefined ? undefined : input.in - (input.cacheRead ?? 0) - (input.cacheWrite ?? 0),
    cacheRead: input.cacheRead,
    cacheWrite: input.cacheWrite,
  },
  outputTokens: {
    total: input.out,
    text: input.out === undefined ? undefined : input.out - (input.reasoning ?? 0),
    reasoning: input.reasoning,
  },
})

const finish: Chunk = { type: "finish", finishReason: "stop", usage: usage({ in: 1, out: 1 }) } as Chunk

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

function harness(turns: readonly Chunk[][], override?: MockLanguageModelV4) {
  const script = scripted(turns)
  const model = override ?? script.model
  const directory = mkdtempSync(join(tmpdir(), "run-"))
  const captured: {
    text: string[]
    tools: { name: string; state: string }[]
    retries: { attempt: number; message: string }[]
  } = { text: [], tools: [], retries: [] }
  const sink = {
    text: (delta: string) => captured.text.push(delta),
    tool: (event: { name: string; state: string }) => captured.tools.push({ name: event.name, state: event.state }),
    retry: (attempt: { attempt: number; message: string }) =>
      captured.retries.push({ attempt: attempt.attempt, message: attempt.message }),
  }
  const layers = layerWith(() => model as never).pipe(
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

describe("token accounting", () => {
  test("persists what the provider reported for the turn", async () => {
    const h = harness([
      [
        { type: "text-start", id: "t0" },
        { type: "text-delta", id: "t0", delta: "hi" },
        { type: "text-end", id: "t0" },
        { type: "finish", finishReason: "stop", usage: usage({ in: 9_000, out: 300, cacheRead: 8_000 }) } as Chunk,
      ],
    ])
    const history = await prompt(h, "hi")

    // input is the non-cached remainder; the cached read is carried separately.
    expect(history[1]!.info.tokens).toMatchObject({ input: 1_000, output: 300, cache: { read: 8_000 } })
    h.cleanup()
  })

  test("leaves tokens absent when the provider reported none", async () => {
    const h = harness([
      [
        { type: "text-start", id: "t0" },
        { type: "text-delta", id: "t0", delta: "hi" },
        { type: "text-end", id: "t0" },
        { type: "finish", finishReason: "stop", usage: usage({}) } as Chunk,
      ],
    ])
    const history = await prompt(h, "hi")

    expect(history[1]!.info.tokens).toBeUndefined()
    h.cleanup()
  })
})

describe("retrying a transient provider failure", () => {
  test("rides out a 503 and delivers the reply the retry produced", async () => {
    const model = flaky(2, () => transient("upstream unavailable", { statusCode: 503 }), text("recovered"))
    const h = harness([], model.model)
    const history = await prompt(h, "hi")

    expect(model.calls()).toBe(3)
    expect(history[1]!.parts[0]).toMatchObject({ type: "text", text: "recovered" })
    h.cleanup()
  })

  /**
   * A silent backoff is indistinguishable from a hang, and the replayed turn
   * will repeat any text the failed attempt already streamed. Both reasons the
   * wait has to be announced.
   */
  test("reports each wait rather than pausing silently", async () => {
    const model = flaky(2, () => transient("rate limit", { statusCode: 429 }), text("ok"))
    const h = harness([], model.model)
    await prompt(h, "hi")

    expect(h.captured.retries.map((r) => r.attempt)).toEqual([1, 2])
    expect(h.captured.retries[0]!.message).toContain("rate limit")
    h.cleanup()
  })

  /**
   * The reason `Effect.retry` sits before `tapError` in the pipeline. A blip
   * that the next attempt recovers from is not a failure the session should
   * carry — recording it early would persist a defeat that never happened.
   */
  test("leaves no error on the message when a later attempt succeeds", async () => {
    const model = flaky(1, () => transient("socket hang up"), text("fine"))
    const h = harness([], model.model)
    const history = await prompt(h, "hi")

    expect(history[1]!.info.error).toBeUndefined()
    expect(history[1]!.info.timeCompleted).toBeDefined()
    h.cleanup()
  })

  test("gives up after the maximum and surfaces one actionable line", async () => {
    const model = flaky(99, () => transient("upstream unavailable", { statusCode: 503 }), text("never"))
    const h = harness([], model.model)

    const failure = await prompt(h, "hi").then(
      () => undefined,
      (error: unknown) => error,
    )

    expect(failure).toBeDefined()
    expect(String(failure)).not.toContain("requestBodyValues")
    // Six calls: the first attempt plus RETRY_MAX_RETRIES.
    expect(model.calls()).toBe(1 + RETRY_MAX_RETRIES)
    h.cleanup()
  })

  test("does not retry a rejected key — five more attempts would fail identically", async () => {
    const model = flaky(
      99,
      () => transient("invalid x-api-key", { statusCode: 401, isRetryable: false, responseHeaders: {} }),
      text("never"),
    )
    const h = harness([], model.model)

    await prompt(h, "hi").catch(() => undefined)

    expect(model.calls()).toBe(1)
    expect(h.captured.retries).toEqual([])
    h.cleanup()
  })

  /** Retrying an oversized prompt re-sends it unchanged, and bills for each attempt. */
  test("does not retry a context overflow", async () => {
    const model = flaky(
      99,
      () => transient("prompt is too long: 210000 tokens > 200000 maximum", { statusCode: 400 }),
      text("never"),
    )
    const h = harness([], model.model)

    await prompt(h, "hi").catch(() => undefined)

    expect(model.calls()).toBe(1)
    h.cleanup()
  })

  test("records the failure on the message once the schedule is exhausted", async () => {
    const model = flaky(99, () => transient("service unavailable", { statusCode: 503 }), text("never"))
    const h = harness([], model.model)

    // One `run`, because layerMemory hands each provide its own database.
    const history = await h.run(
      Effect.gen(function* () {
        const store = yield* SessionStore
        const session = yield* store.create({ title: "t", directory: h.directory })
        const runner = yield* SessionRun
        yield* runner.prompt({ sessionID: session.id, text: "hi", sink: h.sink }).pipe(Effect.ignore)
        return yield* store.messages(session.id)
      }),
    )

    expect(history[1]!.info.error).toContain("service unavailable")
    h.cleanup()
  })
})
