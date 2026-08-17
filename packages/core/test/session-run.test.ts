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
import { SessionInput, layer as inputLayer } from "../src/session/input"
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

/**
 * Provider-level `finishReason` is an object carrying a `unified` field, not the
 * bare string the top-level `fullStream` part exposes. Passing a string makes
 * the SDK read `.unified` off it and hand us undefined.
 */
const reason = (unified: string) => ({ unified }) as never

const finish: Chunk = { type: "finish", finishReason: reason("stop"), usage: usage({ in: 1, out: 1 }) } as Chunk

const text = (value: string): Chunk[] => [
  { type: "text-start", id: "t0" },
  { type: "text-delta", id: "t0", delta: value },
  { type: "text-end", id: "t0" },
  finish,
]

const finishWith = (unified: string): Chunk => ({ ...(finish as object), finishReason: reason(unified) }) as Chunk

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
    compactions: { state: string; reason?: string }[]
    incomplete: { reason: string; detail: string }[]
    reasoning: string[]
  } = { text: [], tools: [], retries: [], compactions: [], incomplete: [], reasoning: [] }
  const sink = {
    text: (delta: string) => captured.text.push(delta),
    tool: (event: { name: string; state: string }) => captured.tools.push({ name: event.name, state: event.state }),
    retry: (attempt: { attempt: number; message: string }) =>
      captured.retries.push({ attempt: attempt.attempt, message: attempt.message }),
    compaction: (event: { state: string; reason?: string }) => captured.compactions.push(event),
    incomplete: (event: { reason: string; detail: string }) => captured.incomplete.push(event),
    reasoning: (delta: string) => captured.reasoning.push(delta),
  }
  const layers = layerWith(() => model as never).pipe(
    Layer.provideMerge(
      registryLayer([
        { name: "echo", tool: echo },
        { name: "explode", tool: explode },
      ]),
    ),
    Layer.provideMerge(inputLayer),
    Layer.provideMerge(storeLayer),
    Layer.provideMerge(layerAllowAll),
    Layer.provideMerge(layerMemory),
  )

  const run = <A, E>(effect: Effect.Effect<A, E, SessionRun | SessionStore | SessionInput>) =>
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

  /**
   * A tool_use with no matching tool_result is rejected outright by Anthropic and
   * OpenAI, and here that rejection is terminal: it classifies as a plain
   * api_error so retry declines it, it is not an overflow so compaction never
   * runs, and the store has no delete — so the same invalid turn is rebuilt on
   * every later prompt and the session can never be used again.
   *
   * The previous version of this test asserted `["assistant"]` under the name
   * "omits a tool call that has not settled". The name described the safe
   * behaviour; the assertion pinned the unsafe one.
   */
  const unsettled = (state: "pending" | "running") => [
    {
      info: { role: "assistant" as const },
      parts: [
        {
          id: "prt_1" as never,
          messageID: "msg_1" as never,
          sessionID: "ses_1" as never,
          type: "tool" as const,
          callID: "call_1",
          tool: "echo",
          state,
        },
      ],
    },
  ]

  test("still answers a tool call that never settled, so the turn stays valid", () => {
    for (const state of ["pending", "running"] as const) {
      const messages = toModelMessages(unsettled(state))
      expect(messages.map((m) => m.role)).toEqual(["assistant", "tool"])
      const result = (messages[1] as { content: { output: { type: string; value: string } }[] }).content[0]!
      expect(result.output.type).toBe("error-text")
      expect(result.output.value).toContain("interrupted")
    }
  })

  test("never emits a call without a matching result", () => {
    const messages = toModelMessages(unsettled("running"))
    const calls = (messages[0] as { content: { type: string; toolCallId?: string }[] }).content.filter(
      (part) => part.type === "tool-call",
    )
    const results = (messages[1] as { content: { toolCallId: string }[] }).content
    expect(results.map((r) => r.toolCallId).sort()).toEqual(calls.map((c) => c.toolCallId!).sort())
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

  /**
   * Reaching the cap mid-task is indistinguishable from finishing — the loop
   * returns, the CLI exits 0, the reply just stops. The same silent-completion
   * shape as a truncated reply, so it is reported the same way.
   */
  test("says so when it stops at the step limit rather than finishing", async () => {
    await withHarness([callTool("echo", { value: "x" })], async (h) => {
      await prompt(h, "go forever")
      expect(h.captured.incomplete.at(-1)?.reason).toBe("step-limit")
      expect(h.captured.incomplete.at(-1)?.detail).toContain("40")
    })
  })

  test("stays quiet about the step limit on a turn that finished normally", async () => {
    await withHarness([text("done")], async (h) => {
      await prompt(h, "hi")
      expect(h.captured.incomplete).toEqual([])
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
    // The SDK flags an unavailable tool before dispatch and names what IS
    // available, which the registry's own "Unknown tool: x" could not. Since
    // this text goes back to the model as the tool result, the difference is
    // whether it can recover on the next turn or just guesses again.
    const message = String((toolPart as { error?: string }).error)
    expect(message).toContain("nonexistent")
    expect(message).toContain("echo")
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
        {
          type: "finish",
          finishReason: reason("stop"),
          usage: usage({ in: 9_000, out: 300, cacheRead: 8_000 }),
        } as Chunk,
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
        { type: "finish", finishReason: reason("stop"), usage: usage({}) } as Chunk,
      ],
    ])
    const history = await prompt(h, "hi")

    expect(history[1]!.info.tokens).toBeUndefined()
    h.cleanup()
  })
})

describe("the drain loop", () => {
  /** Admission is durable and precedes execution — the record outlives the process. */
  test("records the prompt before calling the provider", async () => {
    const h = harness([text("ok")])
    const seen = await h.run(
      Effect.gen(function* () {
        const store = yield* SessionStore
        const inputs = yield* SessionInput
        const session = yield* store.create({ title: "t", directory: h.directory })
        const runner = yield* SessionRun
        yield* runner.prompt({ sessionID: session.id, text: "remember", sink: h.sink })
        return yield* inputs.list(session.id)
      }),
    )
    expect(seen.map((entry) => entry.prompt.text)).toEqual(["remember"])
    // Promoted, not merely admitted.
    expect(seen[0]!.promotedSeq).toBeDefined()
  })

  /**
   * The distinction the whole design exists for. A steer redirects work already
   * in flight; it must land at a turn boundary, not be swallowed or deferred to
   * the next prompt.
   */
  test("a steer admitted mid-drain lands at the next boundary and continues the turn", async () => {
    // The steer is admitted from inside the model call — i.e. genuinely while
    // the session is working — which is the only case the boundary logic exists
    // for. Admitting before prompt() would merely test the idle path.
    let admit: (() => Promise<unknown>) | undefined
    let call = 0
    const doStream = (async () => {
      call++
      if (call === 1 && admit) await admit()
      const chunks = call === 1 ? text("first answer") : text("after the steer")
      return { stream: simulateReadableStream({ chunks, initialDelayInMs: 0, chunkDelayInMs: 0 }) }
    }) as never
    const h = harness([], new MockLanguageModelV4({ doStream }))

    const history = await h.run(
      Effect.gen(function* () {
        const store = yield* SessionStore
        const inputs = yield* SessionInput
        const session = yield* store.create({ title: "t", directory: h.directory })
        const runner = yield* SessionRun
        admit = () =>
          Effect.runPromise(inputs.admit({ sessionID: session.id, prompt: { text: "STEERED" }, delivery: "steer" }))
        yield* runner.prompt({ sessionID: session.id, text: "original", sink: h.sink })
        return yield* store.messages(session.id)
      }),
    )

    const users = history
      .filter((entry) => entry.info.role === "user")
      .map((entry) => (entry.parts[0] as { text: string }).text)
    // The steer arrives after the turn it interrupted, not before it.
    expect(users).toEqual(["original", "STEERED"])
    // The drain continued rather than returning at the end of the first turn.
    expect(call).toBe(2)
    expect(JSON.stringify(history)).toContain("after the steer")
    h.cleanup()
  })

  test("a turn with no steer pending stops at its boundary", async () => {
    const h = harness([text("just this")])
    await prompt(h, "go")
    expect(h.script.turns()).toBe(1)
    h.cleanup()
  })

  /** Exactly one queued prompt per idle, so a backlog is worked through in order. */
  test("works a queued backlog one prompt at a time", async () => {
    const h = harness([text("answer")])
    const history = await h.run(
      Effect.gen(function* () {
        const store = yield* SessionStore
        const inputs = yield* SessionInput
        const session = yield* store.create({ title: "t", directory: h.directory })
        const runner = yield* SessionRun
        yield* inputs.admit({ sessionID: session.id, prompt: { text: "second" }, delivery: "queue" })
        yield* inputs.admit({ sessionID: session.id, prompt: { text: "third" }, delivery: "queue" })
        yield* runner.prompt({ sessionID: session.id, text: "first", sink: h.sink })
        return yield* store.messages(session.id)
      }),
    )

    const users = history
      .filter((entry) => entry.info.role === "user")
      .map((entry) => (entry.parts[0] as { text: string }).text)
    // All three drained, oldest first, each getting its own turn.
    expect(users).toEqual(["second", "third", "first"])
    expect(history.filter((entry) => entry.info.role === "assistant").length).toBe(3)
    h.cleanup()
  })

  test("leaves nothing pending once the drain returns", async () => {
    const h = harness([text("done")])
    const pending = await h.run(
      Effect.gen(function* () {
        const store = yield* SessionStore
        const inputs = yield* SessionInput
        const session = yield* store.create({ title: "t", directory: h.directory })
        const runner = yield* SessionRun
        yield* inputs.admit({ sessionID: session.id, prompt: { text: "q" }, delivery: "queue" })
        yield* inputs.admit({ sessionID: session.id, prompt: { text: "s" }, delivery: "steer" })
        yield* runner.prompt({ sessionID: session.id, text: "go", sink: h.sink })
        return {
          steer: yield* inputs.hasPending(session.id, "steer"),
          queue: yield* inputs.hasPending(session.id, "queue"),
        }
      }),
    )
    expect(pending).toEqual({ steer: false, queue: false })
    h.cleanup()
  })

  /** The admitted record and the conversation entry are one thing, not two rows to reconcile. */
  test("the user message keeps the admitted prompt's identity", async () => {
    const h = harness([text("ok")])
    const result = await h.run(
      Effect.gen(function* () {
        const store = yield* SessionStore
        const inputs = yield* SessionInput
        const session = yield* store.create({ title: "t", directory: h.directory })
        const runner = yield* SessionRun
        yield* runner.prompt({ sessionID: session.id, text: "hi", sink: h.sink })
        const admitted = yield* inputs.list(session.id)
        const history = yield* store.messages(session.id)
        return { admittedID: admitted[0]!.id, messageID: history[0]!.info.id }
      }),
    )
    expect(result.messageID).toBe(result.admittedID)
    h.cleanup()
  })
})

describe("the tool_use / tool_result contract", () => {
  /**
   * The invariant with the worst failure mode in the whole harness. A provider
   * rejects an assistant turn carrying a tool_use with no matching tool_result;
   * that rejection is not retryable, is not an overflow, and the store has no
   * delete — so the session is finished. This walks every request actually sent
   * and checks the pairing holds, rather than checking one part in isolation.
   */
  const unpaired = (prompt: unknown): string[] => {
    const messages = prompt as { role: string; content?: { type?: string; toolCallId?: string }[] }[]
    const problems: string[] = []
    for (const [index, message] of messages.entries()) {
      if (message.role === "tool" && (index === 0 || messages[index - 1]?.role !== "assistant")) {
        problems.push(`tool message at ${index} does not follow an assistant message`)
      }
      if (message.role !== "assistant") continue
      const calls = (message.content ?? []).filter((p) => p.type === "tool-call").map((p) => p.toolCallId)
      if (calls.length === 0) continue
      const next = messages[index + 1]
      const results = next?.role === "tool" ? (next.content ?? []).map((p) => p.toolCallId) : []
      for (const call of calls) if (!results.includes(call)) problems.push(`unanswered ${call} at ${index}`)
      for (const result of results) if (!calls.includes(result)) problems.push(`orphan result ${result}`)
    }
    return problems
  }

  test("holds across a turn mixing valid, malformed and unknown tool calls", async () => {
    const messy: Chunk[] = [
      { type: "tool-call", toolCallId: "c1", toolName: "echo", input: JSON.stringify({ value: "a" }) },
      { type: "tool-call", toolCallId: "c2", toolName: "echo", input: "{bad" } as Chunk,
      { type: "tool-call", toolCallId: "c3", toolName: "nope", input: "{}" } as Chunk,
      finishWith("tool-calls"),
    ]
    await withHarness([messy, text("done")], async (h) => {
      await prompt(h, "go")
      for (const sent of h.script.prompts) expect(unpaired(sent)).toEqual([])
    })
  })

  /** Slicing history at a compaction boundary must not orphan a call from its result. */
  test("holds across a compaction boundary", async () => {
    const BIG = "detail ".repeat(6_000)
    const overflowingToolTurn: Chunk[] = [
      { type: "text-start", id: "t0" },
      { type: "text-delta", id: "t0", delta: BIG },
      { type: "text-end", id: "t0" },
      { type: "tool-call", toolCallId: "c1", toolName: "echo", input: JSON.stringify({ value: "a" }) },
      { type: "finish", finishReason: reason("tool-calls"), usage: usage({ in: 150_000, out: 500 }) } as Chunk,
    ]
    await withHarness([overflowingToolTurn, text("## Objective\n- ok")], async (h) => {
      await prompt(h, "go")
      for (const sent of h.script.prompts) expect(unpaired(sent)).toEqual([])
    })
  })
})

describe("reasoning and block order", () => {
  const reasoningTurn: Chunk[] = [
    { type: "reasoning-start", id: "r0", providerMetadata: { openai: { itemId: "rs_1" } } } as Chunk,
    { type: "reasoning-delta", id: "r0", delta: "let me check the file" } as Chunk,
    { type: "reasoning-delta", id: "r0", delta: " first", providerMetadata: { openai: { encrypted: "abc" } } } as Chunk,
    { type: "reasoning-end", id: "r0" } as Chunk,
    { type: "text-start", id: "t0" },
    { type: "text-delta", id: "t0", delta: "Checking." },
    { type: "text-end", id: "t0" },
    finish,
  ]

  test("stores reasoning, which nothing used to write at all", async () => {
    const h = harness([reasoningTurn])
    const history = await prompt(h, "hi")

    const reasoning = history.flatMap((e) => e.parts).find((p) => p.type === "reasoning") as
      { text: string; metadata?: Record<string, unknown> } | undefined
    expect(reasoning?.text).toBe("let me check the file first")
    h.cleanup()
  })

  /** Merged, not replaced: providers deliver metadata in pieces across a block. */
  test("merges provider metadata arriving across start and deltas", async () => {
    const h = harness([reasoningTurn])
    const history = await prompt(h, "hi")

    const reasoning = history.flatMap((e) => e.parts).find((p) => p.type === "reasoning") as {
      metadata?: Record<string, unknown>
    }
    expect(reasoning.metadata?.["openai"]).toMatchObject({ itemId: "rs_1", encrypted: "abc" })
    h.cleanup()
  })

  test("shows reasoning as it arrives so the terminal is not silent", async () => {
    const h = harness([reasoningTurn])
    await prompt(h, "hi")
    expect(h.captured.reasoning.join("")).toBe("let me check the file first")
    h.cleanup()
  })

  /**
   * Not replayed: sending it back is provider-specific and fails quietly when
   * done wrong. Omitting it costs tokens, not correctness.
   */
  test("does not replay reasoning to the provider", async () => {
    const h = harness([reasoningTurn, text("second")])
    await h.run(
      Effect.gen(function* () {
        const store = yield* SessionStore
        const session = yield* store.create({ title: "t", directory: h.directory })
        const runner = yield* SessionRun
        yield* runner.prompt({ sessionID: session.id, text: "one", sink: h.sink })
        yield* runner.prompt({ sessionID: session.id, text: "two", sink: h.sink })
      }),
    )
    expect(JSON.stringify(h.script.prompts.at(-1))).not.toContain("let me check the file")
    h.cleanup()
  })

  /**
   * Part ids are monotonic ULIDs and parts are read back sorted by id. Tool ids
   * used to be minted at settle time, after the stream, so every tool part
   * sorted after every text part — a turn that called a tool and *then*
   * explained itself was replayed the other way round.
   */
  test("keeps a tool call before the text that followed it", async () => {
    const interleaved: Chunk[] = [
      { type: "tool-call", toolCallId: "call_1", toolName: "echo", input: JSON.stringify({ value: "x" }) },
      { type: "text-start", id: "t0" },
      { type: "text-delta", id: "t0", delta: "and here is why" },
      { type: "text-end", id: "t0" },
      finishWith("tool-calls"),
    ]
    const h = harness([interleaved, text("done")])
    const history = await prompt(h, "go")

    const kinds = history[1]!.parts.map((part) => part.type)
    expect(kinds.indexOf("tool")).toBeLessThan(kinds.indexOf("text"))

    // And the rebuilt provider message preserves it.
    const assistant = toModelMessages(history).find((m) => m.role === "assistant") as {
      content: { type: string }[]
    }
    const types = assistant.content.map((c) => c.type)
    expect(types.indexOf("tool-call")).toBeLessThan(types.indexOf("text"))
    h.cleanup()
  })

  test("keeps separate text blocks separate rather than concatenating them", async () => {
    const twoBlocks: Chunk[] = [
      { type: "text-start", id: "t0" },
      { type: "text-delta", id: "t0", delta: "first block" },
      { type: "text-end", id: "t0" },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "second block" },
      { type: "text-end", id: "t1" },
      finish,
    ]
    const h = harness([twoBlocks])
    const history = await prompt(h, "hi")
    const texts = history[1]!.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text)
    expect(texts).toEqual(["first block", "second block"])
    h.cleanup()
  })
})

describe("early tool feedback", () => {
  /**
   * `tool-input-start` fires when the model commits to a tool name;
   * `tool-call` only once the whole argument JSON has streamed and parsed. For
   * a large edit that gap is seconds, and nothing used to be shown for it.
   */
  test("announces the tool before its arguments have finished streaming", async () => {
    const streamed: Chunk[] = [
      { type: "tool-input-start", id: "call_1", toolName: "echo" } as Chunk,
      { type: "tool-input-delta", id: "call_1", delta: '{"value":' } as Chunk,
      { type: "tool-input-delta", id: "call_1", delta: '"x"}' } as Chunk,
      { type: "tool-input-end", id: "call_1" } as Chunk,
      { type: "tool-call", toolCallId: "call_1", toolName: "echo", input: JSON.stringify({ value: "x" }) },
      finishWith("tool-calls"),
    ]
    await withHarness([streamed, text("done")], async (h) => {
      await prompt(h, "go")
      const states = h.captured.tools.filter((t) => t.name === "echo").map((t) => t.state)
      // pending arrives first, and the call still settles normally afterwards.
      expect(states[0]).toBe("pending")
      expect(states).toContain("completed")
    })
  })

  test("announces at most once per call when the provider also sends deltas", async () => {
    const streamed: Chunk[] = [
      { type: "tool-input-start", id: "call_1", toolName: "echo" } as Chunk,
      { type: "tool-input-start", id: "call_1", toolName: "echo" } as Chunk,
      { type: "tool-call", toolCallId: "call_1", toolName: "echo", input: JSON.stringify({ value: "x" }) },
      finishWith("tool-calls"),
    ]
    await withHarness([streamed, text("done")], async (h) => {
      await prompt(h, "go")
      expect(h.captured.tools.filter((t) => t.state === "pending").length).toBe(1)
    })
  })

  /**
   * The AI SDK ends `fullStream` cleanly on abort rather than throwing, so
   * without an explicit case a cancelled turn is indistinguishable from a short
   * successful one — and would be persisted as a real reply.
   */
  test("treats an aborted stream as a failure, not a short reply", async () => {
    const aborted: Chunk[] = [
      { type: "text-start", id: "t0" },
      { type: "text-delta", id: "t0", delta: "half a th" },
      { type: "abort", reason: "user cancelled" } as Chunk,
    ]
    const h = harness([aborted])
    const failure = await prompt(h, "go").then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(failure).toBeDefined()
    h.cleanup()
  })
})

describe("malformed tool calls", () => {
  /**
   * When the model emits unparsable arguments the SDK hands back the raw
   * argument *string* as `input`, flagged `invalid`. Stored and replayed that
   * becomes a tool_use whose input is not an object, which providers reject —
   * and since the store has no delete, the session never recovers.
   */
  const malformed: Chunk[] = [
    { type: "tool-call", toolCallId: "call_1", toolName: "echo", input: "{value:" } as Chunk,
    finishWith("tool-calls"),
  ]

  test("records the SDK's own diagnosis rather than a vaguer one", async () => {
    const h = harness([malformed, text("corrected")])
    const history = await prompt(h, "go")

    const toolPart = history.flatMap((entry) => entry.parts).find((part) => part.type === "tool") as {
      state: string
      error?: string
    }
    expect(toolPart.state).toBe("error")
    // The SDK names the problem; the registry's schema decoder would not have.
    expect(toolPart.error).toMatch(/JSON parsing failed|JSON Parse error/i)
    // It names the tool and quotes the text that would not parse.
    expect(toolPart.error).toContain("echo")
    expect(toolPart.error).toContain("{value:")
    h.cleanup()
  })

  test("never replays a tool input that is not an object", async () => {
    const h = harness([malformed, text("corrected")])
    await prompt(h, "go")

    const replayed = JSON.stringify(h.script.prompts.at(-1))
    expect(replayed).not.toContain('"input":"{value:"')
    h.cleanup()
  })

  test("lets the model correct itself instead of ending the turn", async () => {
    await withHarness([malformed, text("corrected")], async (h) => {
      const history = await prompt(h, "go")
      expect(h.script.turns()).toBeGreaterThanOrEqual(2)
      expect(JSON.stringify(history)).toContain("corrected")
    })
  })

  test("does not dispatch a malformed call to the registry", async () => {
    // `echo` would succeed if reached, so a successful settlement proves dispatch.
    const h = harness([malformed, text("done")])
    const history = await prompt(h, "go")
    const outputs = history.flatMap((e) => e.parts).filter((p) => p.type === "tool")
    expect(outputs.every((p) => (p as { state: string }).state === "error")).toBe(true)
    h.cleanup()
  })
})

describe("finish reasons", () => {
  const stopping = (reason: string): Chunk[] => [
    { type: "text-start", id: "t0" },
    { type: "text-delta", id: "t0", delta: "partial answer that stops mid-" },
    { type: "text-end", id: "t0" },
    finishWith(reason),
  ]

  test("records why the provider stopped", async () => {
    const h = harness([text("done")])
    const history = await prompt(h, "hi")
    expect(history[1]!.info.finish).toBe("stop")
    h.cleanup()
  })

  /**
   * A reply cut off at the output limit reads exactly like a complete one — the
   * text just ends. Without this the only signal is a sentence stopping
   * mid-word, which is indistinguishable from the model choosing to stop.
   */
  test("says so when the reply was truncated at the output limit", async () => {
    const h = harness([stopping("length")])
    const history = await prompt(h, "hi")

    expect(history[1]!.info.finish).toBe("length")
    expect(h.captured.incomplete.at(0)?.reason).toBe("length")
    expect(h.captured.incomplete.at(0)?.detail).toContain("output limit")
    h.cleanup()
  })

  test("says so when a content filter stopped the reply", async () => {
    const h = harness([stopping("content-filter")])
    await prompt(h, "hi")
    expect(h.captured.incomplete.at(0)?.reason).toBe("content-filter")
    h.cleanup()
  })

  test("stays quiet on an ordinary stop", async () => {
    const h = harness([text("all done")])
    await prompt(h, "hi")
    expect(h.captured.incomplete).toEqual([])
    h.cleanup()
  })

  /**
   * Continuing would re-run the same request and truncate at the same place.
   * Deciding purely on "were there tool calls" would loop until MAX_STEPS.
   */
  test("does not continue past a truncated turn even though it made tool calls", async () => {
    const truncatedToolCall: Chunk[] = [
      { type: "tool-call", toolCallId: "call_1", toolName: "echo", input: JSON.stringify({ value: "x" }) },
      finishWith("length"),
    ]
    await withHarness([truncatedToolCall], async (h) => {
      await prompt(h, "go")
      // One provider call, not forty.
      expect(h.script.turns()).toBe(1)
      expect(h.captured.incomplete.at(0)?.reason).toBe("length")
    })
  })
})

describe("interrupted tool calls", () => {
  /**
   * Tool parts are written `running` before execution. Anything that stops the
   * settle loop part-way leaves them claiming to be in flight forever, and
   * toModelMessages skips unsettled parts — so the model sees a call it made
   * with no result, and loses the fact that it ever ran.
   */
  test("forces a part left mid-flight into a terminal state", async () => {
    const hang = makeTool({
      description: "dies during execution",
      input: Schema.Struct({}),
      // A defect, not a ToolFailure: this escapes settle's normal error path.
      execute: () => Effect.die(new Error("process fell over")),
    })
    const h = harness([callTool("hang", {}), text("after")])
    const layers = layerWith(() => h.script.model as never).pipe(
      Layer.provideMerge(registryLayer([{ name: "hang", tool: hang }])),
      Layer.provideMerge(inputLayer),
      Layer.provideMerge(storeLayer),
      Layer.provideMerge(layerAllowAll),
      Layer.provideMerge(layerMemory),
    )

    const history = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* SessionStore
        const session = yield* store.create({ title: "t", directory: h.directory })
        const runner = yield* SessionRun
        yield* runner.prompt({ sessionID: session.id, text: "go", sink: h.sink }).pipe(Effect.ignore)
        return yield* store.messages(session.id)
      }).pipe(Effect.provide(layers), Effect.scoped),
    )

    const toolParts = history.flatMap((entry) => entry.parts).filter((part) => part.type === "tool")
    expect(toolParts.length).toBeGreaterThan(0)
    // Nothing is left claiming to still be running.
    expect(toolParts.every((part) => part.state === "completed" || part.state === "error")).toBe(true)
    h.cleanup()
  })
})

describe("compaction", () => {
  /**
   * A turn that is both *reported* as over budget and *actually* long enough to
   * have something worth summarizing.
   *
   * Both halves matter. Reported usage is what trips the overflow check, but
   * `select` works on the stored transcript — so a turn claiming 150k tokens
   * while storing three words correctly compacts to nothing and declines.
   */
  const BIG = "detail ".repeat(6_000)
  const overflowing: Chunk[] = [
    { type: "text-start", id: "t0" },
    { type: "text-delta", id: "t0", delta: BIG },
    { type: "text-end", id: "t0" },
    { type: "finish", finishReason: reason("stop"), usage: usage({ in: 150_000, out: 500 }) } as Chunk,
  ]

  test("summarizes once reported usage crosses the model's usable budget", async () => {
    // Turn 1 overflows; turn 2 is the summarizer; both replay from `scripted`.
    const h = harness([overflowing, text("## Objective\n- keep going")])
    await prompt(h, "hi")

    expect(h.captured.compactions.map((c) => c.state)).toEqual(["started", "completed"])
    h.cleanup()
  })

  test("leaves a conversation that fits entirely alone", async () => {
    const h = harness([text("small reply")])
    await prompt(h, "hi")
    expect(h.captured.compactions).toEqual([])
    h.cleanup()
  })

  /**
   * The point of the whole exercise: after compaction the provider must stop
   * being sent the original history.
   */
  test("replaces the earlier history in the next request", async () => {
    const h = harness([overflowing, text("## Objective\n- distinctive-summary-marker")])
    await h.run(
      Effect.gen(function* () {
        const store = yield* SessionStore
        const session = yield* store.create({ title: "t", directory: h.directory })
        const runner = yield* SessionRun
        yield* runner.prompt({ sessionID: session.id, text: "remember-this-original-turn", sink: h.sink })
        yield* runner.prompt({ sessionID: session.id, text: "second", sink: h.sink })
      }),
    )

    const latest = JSON.stringify(h.script.prompts.at(-1))
    expect(latest).toContain("distinctive-summary-marker")
    expect(latest).toContain("This conversation was compacted")
    expect(latest).not.toContain("remember-this-original-turn")
    h.cleanup()
  })

  test("keeps the full history on disk — compaction changes the request, not the record", async () => {
    const h = harness([overflowing, text("## Objective\n- summarized")])
    const history = await prompt(h, "remember-this-original-turn")

    const stored = JSON.stringify(history)
    expect(stored).toContain("remember-this-original-turn")
    expect(history.some((entry) => entry.parts.some((part) => part.type === "compaction"))).toBe(true)
    h.cleanup()
  })

  /**
   * The reactive path. `retryable` refuses to retry an overflow because a plain
   * retry re-sends the same oversized input; this retries a smaller one, which
   * is a different thing.
   */
  test("compacts and retries when the provider rejects the request as too long", async () => {
    let call = 0
    const doStream = (async () => {
      call++
      // 1: a long first turn, so there is history to summarize.
      // 2: the second turn, rejected as too long.
      // 3: the summarizer.  4: the retry, against a compacted history.
      if (call === 1)
        return { stream: simulateReadableStream({ chunks: text(BIG), initialDelayInMs: 0, chunkDelayInMs: 0 }) }
      if (call === 2) throw transient("prompt is too long", { statusCode: 400, isRetryable: false })
      const chunks = call === 3 ? text("## Objective\n- recovered") : text("after compaction")
      return { stream: simulateReadableStream({ chunks, initialDelayInMs: 0, chunkDelayInMs: 0 }) }
    }) as never
    const h = harness([], new MockLanguageModelV4({ doStream }))

    const history = await h.run(
      Effect.gen(function* () {
        const store = yield* SessionStore
        const session = yield* store.create({ title: "t", directory: h.directory })
        const runner = yield* SessionRun
        yield* runner.prompt({ sessionID: session.id, text: "first", sink: h.sink })
        yield* runner.prompt({ sessionID: session.id, text: "second", sink: h.sink })
        return yield* store.messages(session.id)
      }),
    )

    expect(h.captured.compactions.map((c) => c.state)).toEqual(["started", "completed"])
    expect(call).toBe(4)
    expect(JSON.stringify(history)).toContain("after compaction")
    h.cleanup()
  })

  /**
   * Compaction has to shrink monotonically. If the second pass re-reads history
   * the first pass already replaced, each summary prompt is bigger than the last
   * — and within a couple of rounds it trips the summaryFits guard and stops
   * compacting entirely, which is exactly when it is most needed.
   */
  test("summarizes only what happened since the last boundary", async () => {
    const prompts: string[] = []
    let call = 0
    const doStream = (async (options: { prompt: unknown }) => {
      call++
      prompts.push(JSON.stringify(options.prompt))
      // Odd calls are real turns that overflow; even calls are the summarizer.
      const chunks = call % 2 === 1 ? overflowing : text(`## Objective\n- summary-${call}`)
      return { stream: simulateReadableStream({ chunks, initialDelayInMs: 0, chunkDelayInMs: 0 }) }
    }) as never
    const h = harness([], new MockLanguageModelV4({ doStream }))

    await h.run(
      Effect.gen(function* () {
        const store = yield* SessionStore
        const session = yield* store.create({ title: "t", directory: h.directory })
        const runner = yield* SessionRun
        yield* runner.prompt({ sessionID: session.id, text: "ORIGINAL-FIRST-TURN", sink: h.sink })
        yield* runner.prompt({ sessionID: session.id, text: "second", sink: h.sink })
      }),
    )

    expect(h.captured.compactions.filter((c) => c.state === "completed").length).toBeGreaterThanOrEqual(2)
    // The summarizer prompts are the even-numbered calls. The later one must not
    // be re-reading the turn the earlier one already replaced.
    const summarizerPrompts = prompts.filter((_, index) => (index + 1) % 2 === 0)
    expect(summarizerPrompts.length).toBeGreaterThanOrEqual(2)
    expect(summarizerPrompts.at(-1)).not.toContain("ORIGINAL-FIRST-TURN")
    h.cleanup()
  })

  test("surfaces the original failure when compaction cannot help", async () => {
    // Nothing to summarize on the very first turn, so compaction declines.
    const model = flaky(99, () => transient("prompt is too long", { statusCode: 400, isRetryable: false }), text("x"))
    const h = harness([], model.model)

    const failure = await prompt(h, "hi").then(
      () => undefined,
      (error: unknown) => error,
    )

    expect(String(failure)).toContain("too long")
    h.cleanup()
  })

  test("does not take the turn down when the summarizer itself fails", async () => {
    let call = 0
    const doStream = (async () => {
      call++
      if (call === 1)
        return { stream: simulateReadableStream({ chunks: overflowing, initialDelayInMs: 0, chunkDelayInMs: 0 }) }
      // Every summarization attempt fails.
      throw transient("upstream unavailable", { statusCode: 503 })
    }) as never
    const h = harness([], new MockLanguageModelV4({ doStream }))

    const history = await prompt(h, "hi")

    expect(h.captured.compactions.at(-1)?.state).toBe("skipped")
    // The original turn survived intact, and no boundary was written.
    expect(history[1]!.parts[0]).toMatchObject({ type: "text", text: BIG })
    expect(history.some((entry) => entry.parts.some((part) => part.type === "compaction"))).toBe(false)
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
