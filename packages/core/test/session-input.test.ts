import { sessionID as newSessionID, type SessionID } from "@compass/schema"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { layer as layerFile, layerMemory } from "../src/database/database"
import { SessionInput, layer as inputLayer } from "../src/session/input"
import { SessionStore, layer as storeLayer } from "../src/session/store"

/**
 * Durable admission, without the loop.
 *
 * A prompt is recorded before any provider work begins, so a crash between "the
 * user asked" and "the model was called" cannot lose it. Promotion is a
 * separate, later act — which is what allows steer and queue to differ.
 */
const layers = inputLayer.pipe(Layer.provideMerge(storeLayer), Layer.provideMerge(layerMemory))

const run = <A>(body: (session: SessionID) => Effect.Effect<A, never, SessionInput | SessionStore>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* SessionStore
      const session = yield* store.create({ title: "t", directory: "/tmp" })
      return yield* body(session.id)
    }).pipe(Effect.provide(layers), Effect.scoped) as Effect.Effect<A>,
  )

const prompt = (text: string) => ({ text })

describe("admission", () => {
  test("records a prompt as pending, before anything is sent", async () => {
    const result = await run((session) =>
      Effect.gen(function* () {
        const input = yield* SessionInput
        const admitted = yield* input.admit({ sessionID: session, prompt: prompt("do the thing"), delivery: "queue" })
        const stored = yield* input.find(admitted.id)
        return { admitted, stored }
      }),
    )

    expect(result.admitted.promotedSeq).toBeUndefined()
    expect(result.stored?.prompt.text).toBe("do the thing")
    // Survives the round-trip through JSON, which is the whole point of storing it.
    expect(result.stored?.delivery).toBe("queue")
  })

  test("hands out increasing sequences within a session", async () => {
    const seqs = await run((session) =>
      Effect.gen(function* () {
        const input = yield* SessionInput
        const a = yield* input.admit({ sessionID: session, prompt: prompt("a"), delivery: "queue" })
        const b = yield* input.admit({ sessionID: session, prompt: prompt("b"), delivery: "queue" })
        const c = yield* input.admit({ sessionID: session, prompt: prompt("c"), delivery: "steer" })
        return [a.admittedSeq, b.admittedSeq, c.admittedSeq]
      }),
    )
    expect(seqs).toEqual([1, 2, 3])
  })

  test("counts sequences per session, not globally", async () => {
    const first = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* SessionStore
        const input = yield* SessionInput
        const one = yield* store.create({ title: "one", directory: "/tmp" })
        const two = yield* store.create({ title: "two", directory: "/tmp" })
        yield* input.admit({ sessionID: one.id, prompt: prompt("a"), delivery: "queue" })
        yield* input.admit({ sessionID: one.id, prompt: prompt("b"), delivery: "queue" })
        const fresh = yield* input.admit({ sessionID: two.id, prompt: prompt("c"), delivery: "queue" })
        return fresh.admittedSeq
      }).pipe(Effect.provide(layers), Effect.scoped) as Effect.Effect<number>,
    )
    expect(first).toBe(1)
  })
})

describe("pending", () => {
  test("distinguishes the two delivery kinds", async () => {
    const result = await run((session) =>
      Effect.gen(function* () {
        const input = yield* SessionInput
        yield* input.admit({ sessionID: session, prompt: prompt("steer me"), delivery: "steer" })
        return {
          steer: yield* input.hasPending(session, "steer"),
          queue: yield* input.hasPending(session, "queue"),
        }
      }),
    )
    expect(result).toEqual({ steer: true, queue: false })
  })

  test("stops reporting a prompt once it has been promoted", async () => {
    const after = await run((session) =>
      Effect.gen(function* () {
        const input = yield* SessionInput
        const admitted = yield* input.admit({ sessionID: session, prompt: prompt("q"), delivery: "queue" })
        yield* input.promoteNextQueued(session)
        return { pending: yield* input.hasPending(session, "queue"), stored: yield* input.find(admitted.id) }
      }),
    )
    expect(after.pending).toBe(false)
    expect(after.stored?.promotedSeq).toBeDefined()
  })
})

describe("steer promotion", () => {
  test("promotes every steer admitted at or before the cutoff, oldest first", async () => {
    const promoted = await run((session) =>
      Effect.gen(function* () {
        const input = yield* SessionInput
        const a = yield* input.admit({ sessionID: session, prompt: prompt("first"), delivery: "steer" })
        yield* input.admit({ sessionID: session, prompt: prompt("second"), delivery: "steer" })
        return yield* input.promoteSteers(session, a.admittedSeq + 1)
      }),
    )
    expect(promoted.map((entry) => entry.prompt.text)).toEqual(["first", "second"])
  })

  /**
   * The cutoff is what stops this swallowing its own tail. A steer arriving
   * while the turn is being assembled belongs to the next boundary — without
   * the bound, a fast enough typist could keep a turn from ever starting.
   */
  test("leaves a steer that arrived after the cutoff for the next boundary", async () => {
    const result = await run((session) =>
      Effect.gen(function* () {
        const input = yield* SessionInput
        const early = yield* input.admit({ sessionID: session, prompt: prompt("early"), delivery: "steer" })
        yield* input.admit({ sessionID: session, prompt: prompt("late"), delivery: "steer" })
        const promoted = yield* input.promoteSteers(session, early.admittedSeq)
        return { promoted, stillPending: yield* input.hasPending(session, "steer") }
      }),
    )
    expect(result.promoted.map((entry) => entry.prompt.text)).toEqual(["early"])
    expect(result.stillPending).toBe(true)
  })

  test("never promotes a queued prompt", async () => {
    const result = await run((session) =>
      Effect.gen(function* () {
        const input = yield* SessionInput
        yield* input.admit({ sessionID: session, prompt: prompt("queued"), delivery: "queue" })
        const promoted = yield* input.promoteSteers(session, 99)
        return { promoted, queued: yield* input.hasPending(session, "queue") }
      }),
    )
    expect(result.promoted).toEqual([])
    expect(result.queued).toBe(true)
  })

  test("is a no-op when nothing is pending", async () => {
    const promoted = await run((session) =>
      Effect.gen(function* () {
        const input = yield* SessionInput
        return yield* input.promoteSteers(session, 99)
      }),
    )
    expect(promoted).toEqual([])
  })
})

describe("queue promotion", () => {
  /** Exactly one, so a backlog does not all arrive at once the moment the session idles. */
  test("promotes only the oldest queued prompt", async () => {
    const result = await run((session) =>
      Effect.gen(function* () {
        const input = yield* SessionInput
        yield* input.admit({ sessionID: session, prompt: prompt("first"), delivery: "queue" })
        yield* input.admit({ sessionID: session, prompt: prompt("second"), delivery: "queue" })
        const promoted = yield* input.promoteNextQueued(session)
        return { promoted, stillPending: yield* input.hasPending(session, "queue") }
      }),
    )
    expect(result.promoted?.prompt.text).toBe("first")
    expect(result.stillPending).toBe(true)
  })

  test("reports nothing when the queue is empty", async () => {
    const promoted = await run((session) =>
      Effect.gen(function* () {
        const input = yield* SessionInput
        return yield* input.promoteNextQueued(session)
      }),
    )
    expect(promoted).toBeUndefined()
  })

  test("never delivers the same prompt twice", async () => {
    const result = await run((session) =>
      Effect.gen(function* () {
        const input = yield* SessionInput
        yield* input.admit({ sessionID: session, prompt: prompt("only"), delivery: "queue" })
        const first = yield* input.promoteNextQueued(session)
        const second = yield* input.promoteNextQueued(session)
        return { first, second }
      }),
    )
    expect(result.first?.prompt.text).toBe("only")
    expect(result.second).toBeUndefined()
  })
})

describe("durability", () => {
  /**
   * The reason admission is separate from execution at all: the record has to
   * outlive the process that took it.
   */
  test("an admitted prompt is readable after everything in memory is gone", async () => {
    const sessionId = newSessionID()
    const path = `/tmp/compass-input-${sessionId}.db`

    const openAndAdmit = Effect.gen(function* () {
      const store = yield* SessionStore
      const input = yield* SessionInput
      const session = yield* store.create({ title: "t", directory: "/tmp" })
      yield* input.admit({ sessionID: session.id, prompt: prompt("survive me"), delivery: "queue" })
      return session.id
    })

    const fileLayers = inputLayer.pipe(Layer.provideMerge(storeLayer), Layer.provideMerge(layerFile(path)))

    const created = await Effect.runPromise(
      openAndAdmit.pipe(Effect.provide(fileLayers), Effect.scoped) as Effect.Effect<SessionID>,
    )

    // A completely fresh service graph over the same file — nothing carried over.
    const recovered = await Effect.runPromise(
      Effect.gen(function* () {
        const input = yield* SessionInput
        return yield* input.list(created)
      }).pipe(Effect.provide(fileLayers), Effect.scoped) as Effect.Effect<readonly { prompt: { text: string } }[]>,
    )

    expect(recovered.map((entry) => entry.prompt.text)).toEqual(["survive me"])
    await import("node:fs").then((fs) => {
      for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${path}${suffix}`, { force: true })
    })
  })
})
