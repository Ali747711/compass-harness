import { partID, SessionID } from "@compass/schema"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { layerMemory } from "../src/database/database"
import { SessionNotFound, SessionStore, layer as storeLayer } from "../src/session/store"

const TestLayer = storeLayer.pipe(Layer.provideMerge(layerMemory))

const run = <A, E>(effect: Effect.Effect<A, E, SessionStore>) =>
  Effect.runPromise(effect.pipe(Effect.provide(TestLayer), Effect.scoped) as Effect.Effect<A, E>)

describe("SessionStore", () => {
  test("creates and reads back a session", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* SessionStore
        const created = yield* store.create({ title: "hello", directory: "/tmp/x" })
        const fetched = yield* store.get(created.id)
        return { created, fetched }
      }),
    )
    expect(result.fetched.id).toBe(result.created.id)
    expect(result.fetched.title).toBe("hello")
    expect(result.fetched.directory).toBe("/tmp/x")
    expect(result.fetched.parentID).toBeUndefined()
  })

  test("preserves parentID so subagent sessions work without a migration", async () => {
    const parentID = await run(
      Effect.gen(function* () {
        const store = yield* SessionStore
        const parent = yield* store.create({ title: "parent", directory: "/tmp" })
        const child = yield* store.create({ title: "child", directory: "/tmp", parentID: parent.id })
        const fetched = yield* store.get(child.id)
        return fetched.parentID
      }),
    )
    expect(parentID).toBeDefined()
    expect(parentID?.startsWith("ses_")).toBe(true)
  })

  test("fails with SessionNotFound for an unknown id", async () => {
    const error = await run(
      Effect.gen(function* () {
        const store = yield* SessionStore
        return yield* store.get(SessionID.make("ses_missing")).pipe(Effect.flip)
      }),
    )
    expect(error).toBeInstanceOf(SessionNotFound)
  })

  test("round-trips messages and parts in id order", async () => {
    const history = await run(
      Effect.gen(function* () {
        const store = yield* SessionStore
        const session = yield* store.create({ title: "t", directory: "/tmp" })
        const user = yield* store.appendMessage({ sessionID: session.id, role: "user" })
        yield* store.putPart({
          id: partID(),
          messageID: user.id,
          sessionID: session.id,
          type: "text",
          text: "question",
        })
        const assistant = yield* store.appendMessage({
          sessionID: session.id,
          role: "assistant",
          providerID: "anthropic",
          modelID: "claude-sonnet-4-5",
        })
        yield* store.putPart({
          id: partID(),
          messageID: assistant.id,
          sessionID: session.id,
          type: "text",
          text: "answer",
        })
        yield* store.completeMessage({ id: assistant.id })
        return yield* store.messages(session.id)
      }),
    )

    expect(history).toHaveLength(2)
    expect(history[0]!.info.role).toBe("user")
    expect(history[1]!.info.role).toBe("assistant")
    expect(history[1]!.info.modelID).toBe("claude-sonnet-4-5")
    expect(history[1]!.info.timeCompleted).toBeDefined()
    const part = history[1]!.parts[0]!
    expect(part.type).toBe("text")
    expect(part.type === "text" && part.text).toBe("answer")
  })

  test("putPart upserts so streaming deltas rewrite one row", async () => {
    const parts = await run(
      Effect.gen(function* () {
        const store = yield* SessionStore
        const session = yield* store.create({ title: "t", directory: "/tmp" })
        const message = yield* store.appendMessage({ sessionID: session.id, role: "assistant" })
        const id = partID()
        yield* store.putPart({ id, messageID: message.id, sessionID: session.id, type: "text", text: "par" })
        yield* store.putPart({ id, messageID: message.id, sessionID: session.id, type: "text", text: "partial" })
        return yield* store.parts(message.id)
      }),
    )
    expect(parts).toHaveLength(1)
    expect(parts[0]!.type === "text" && parts[0]!.text).toBe("partial")
  })

  test("round-trips a tool part through the JSON column", async () => {
    const parts = await run(
      Effect.gen(function* () {
        const store = yield* SessionStore
        const session = yield* store.create({ title: "t", directory: "/tmp" })
        const message = yield* store.appendMessage({ sessionID: session.id, role: "assistant" })
        yield* store.putPart({
          id: partID(),
          messageID: message.id,
          sessionID: session.id,
          type: "tool",
          callID: "call_1",
          tool: "read",
          state: "completed",
          input: { path: "/tmp/a" },
          output: "contents",
        })
        return yield* store.parts(message.id)
      }),
    )
    const part = parts[0]!
    expect(part.type).toBe("tool")
    if (part.type !== "tool") throw new Error("expected tool part")
    expect(part.tool).toBe("read")
    expect(part.state).toBe("completed")
    expect(part.input).toEqual({ path: "/tmp/a" })
  })
})
