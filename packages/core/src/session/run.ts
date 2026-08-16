import { partID as newPartID, type Part, type SessionID, type TextPart } from "@compass/schema"
import { streamText, type ModelMessage } from "ai"
import { Context, Effect, Layer } from "effect"
import { parseModel, resolveModel, type ModelRef } from "../provider/provider"
import { SessionStore } from "./store"

/**
 * Where streamed output goes. M0 prints to stdout; M3 replaces this with the
 * durable event stream so the TUI and `serve` clients see the same thing.
 */
export interface Sink {
  readonly text: (delta: string) => void
}

export interface RunInput {
  readonly sessionID: SessionID
  readonly text: string
  readonly model?: string
  readonly sink: Sink
}

export interface Interface {
  readonly prompt: (input: RunInput) => Effect.Effect<string>
}

export class SessionRun extends Context.Tag("compass/SessionRun")<SessionRun, Interface>() {}

function toModelMessages(history: readonly { info: { role: "user" | "assistant" }; parts: readonly Part[] }[]) {
  const messages: ModelMessage[] = []
  for (const entry of history) {
    const text = entry.parts
      .filter((part): part is TextPart => part.type === "text")
      .map((part) => part.text)
      .join("")
    if (text.length === 0) continue
    messages.push({ role: entry.info.role, content: text })
  }
  return messages
}

export const layer = Layer.effect(
  SessionRun,
  Effect.gen(function* () {
    const store = yield* SessionStore

    const prompt: Interface["prompt"] = (input) =>
      Effect.gen(function* () {
        const ref: ModelRef = parseModel(input.model)

        // The user turn is persisted before any provider work, so a crash during
        // the call cannot lose what was asked. M2 makes this a durable admission.
        const user = yield* store.appendMessage({ sessionID: input.sessionID, role: "user" })
        yield* store.putPart({
          id: newPartID(),
          messageID: user.id,
          sessionID: input.sessionID,
          type: "text",
          text: input.text,
        })
        yield* store.completeMessage({ id: user.id })

        const history = yield* store.messages(input.sessionID)

        const assistant = yield* store.appendMessage({
          sessionID: input.sessionID,
          role: "assistant",
          providerID: ref.providerID,
          modelID: ref.modelID,
        })
        const textPartID = newPartID()

        const collected = yield* Effect.tryPromise({
          try: async () => {
            const result = streamText({ model: resolveModel(ref), messages: toModelMessages(history) })
            let text = ""
            for await (const part of result.fullStream) {
              if (part.type !== "text-delta") continue
              text += part.text
              input.sink.text(part.text)
            }
            return text
          },
          catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
        }).pipe(
          Effect.tapError((error) => store.completeMessage({ id: assistant.id, error: error.message })),
          Effect.orDie,
        )

        yield* store.putPart({
          id: textPartID,
          messageID: assistant.id,
          sessionID: input.sessionID,
          type: "text",
          text: collected,
        })
        yield* store.completeMessage({ id: assistant.id })
        return collected
      })

    return SessionRun.of({ prompt })
  }),
)
