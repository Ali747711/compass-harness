import {
  partID as newPartID,
  type MessageID,
  type Part,
  type SessionID,
  type TextPart,
  type ToolPart,
} from "@compass/schema"
import { jsonSchema, streamText, tool as aiTool, type LanguageModel, type ModelMessage, type ToolSet } from "ai"
import { Context, Effect, Layer } from "effect"
import { prune } from "../context/pipeline"
import { parseModel, resolveModel, type ModelRef } from "../provider/provider"
import { ToolRegistry } from "../tool/registry"
import { parameters } from "../tool/tool"
import { SessionStore } from "./store"

/**
 * Where streamed activity goes. M0 printed to stdout; M3 replaces this with the
 * durable event stream so TUI and `serve` clients observe the same thing.
 */
export interface Sink {
  readonly text: (delta: string) => void
  readonly tool: (event: { readonly name: string; readonly state: ToolPart["state"]; readonly title?: string }) => void
}

export interface RunInput {
  readonly sessionID: SessionID
  readonly text: string
  readonly model?: string
  readonly sink: Sink
}

export interface Interface {
  readonly prompt: (input: RunInput) => Effect.Effect<void>
}

export class SessionRun extends Context.Service<SessionRun, Interface>()("compass/SessionRun") {}

/**
 * How a model reference becomes a callable model.
 *
 * Injected rather than imported so the loop can be exercised without a
 * provider. Without this seam the only way to reach a turn is a live API call,
 * which would leave the agent loop — the least forgiving code here — untested.
 */
export type ResolveModel = (ref: ModelRef) => LanguageModel

/** Bounds runaway tool loops. M2 replaces this with a per-agent turn allowance. */
const MAX_STEPS = 40

const SYSTEM = [
  "You are compass, a coding agent running in a terminal.",
  "Use the provided tools to inspect and modify the user's project.",
  "Prefer reading files before editing them. Be concise in your replies.",
].join(" ")

interface HistoryEntry {
  readonly info: { readonly role: "user" | "assistant" }
  readonly parts: readonly Part[]
}

/**
 * Rebuilds provider messages from durable history rather than keeping an
 * in-memory conversation. Every turn is reconstructed from what was persisted,
 * so a crash mid-loop resumes from the same state the model last saw.
 */
export function toModelMessages(history: readonly HistoryEntry[]): ModelMessage[] {
  const messages: ModelMessage[] = []
  for (const entry of history) {
    const text = entry.parts
      .filter((part): part is TextPart => part.type === "text")
      .map((part) => part.text)
      .join("")
    const tools = entry.parts.filter((part): part is ToolPart => part.type === "tool")

    if (entry.info.role === "user") {
      if (text.length > 0) messages.push({ role: "user", content: text })
      continue
    }

    const content: Extract<ModelMessage, { role: "assistant" }>["content"] = []
    if (text.length > 0) content.push({ type: "text", text })
    for (const part of tools) {
      content.push({ type: "tool-call", toolCallId: part.callID, toolName: part.tool, input: part.input ?? {} })
    }
    if (content.length > 0) messages.push({ role: "assistant", content })

    // Tool results are a separate provider message and must follow the call
    // that produced them, in the same order.
    const settled = tools.filter((part) => part.state === "completed" || part.state === "error")
    if (settled.length === 0) continue
    messages.push({
      role: "tool",
      content: settled.map((part) => ({
        type: "tool-result" as const,
        toolCallId: part.callID,
        toolName: part.tool,
        output:
          part.state === "error"
            ? { type: "error-text" as const, value: part.error ?? "tool failed" }
            : { type: "text" as const, value: part.output ?? "" },
      })),
    })
  }
  return messages
}

export const layerWith = (resolve: ResolveModel) =>
  Layer.effect(
    SessionRun,
    Effect.gen(function* () {
      const store = yield* SessionStore
      const registry = yield* ToolRegistry

      /**
       * Tools are advertised without an `execute` implementation on purpose. The
       * AI SDK will then surface tool calls instead of running them itself, which
       * keeps one explicit provider call per turn and leaves execution, bounding,
       * and persistence here rather than inside a hidden in-memory loop.
       */
      const toolSet: ToolSet = Object.fromEntries(
        registry.list().map((entry) => [
          entry.name,
          aiTool({
            description: entry.tool.description,
            // Effect's JsonSchema document and the AI SDK's JSONSchema7 are the
            // same draft-7 document but nominally distinct types, so the cast is
            // the impedance mismatch and not a loss of safety.
            inputSchema: jsonSchema(parameters(entry.tool) as unknown as Parameters<typeof jsonSchema>[0]),
          }),
        ]),
      )

      const runTurn = (input: {
        readonly sessionID: SessionID
        readonly directory: string
        readonly ref: ModelRef
        readonly sink: Sink
      }) =>
        Effect.gen(function* () {
          const history = yield* store.messages(input.sessionID)
          const assistant = yield* store.appendMessage({
            sessionID: input.sessionID,
            role: "assistant",
            providerID: input.ref.providerID,
            modelID: input.ref.modelID,
          })

          const turn = yield* Effect.tryPromise({
            try: async () => {
              const result = streamText({
                model: resolve(input.ref),
                system: SYSTEM,
                // Prune tier 1 before the request: old tool results are shortened
                // outside a protected recent window. A no-op under the threshold.
                messages: prune(toModelMessages(history)).messages,
                tools: toolSet,
              })
              let text = ""
              const calls: { id: string; name: string; input: unknown }[] = []
              for await (const part of result.fullStream) {
                if (part.type === "text-delta") {
                  text += part.text
                  input.sink.text(part.text)
                  continue
                }
                if (part.type === "tool-call") {
                  calls.push({ id: part.toolCallId, name: part.toolName, input: part.input })
                  continue
                }
                if (part.type === "error")
                  throw part.error instanceof Error ? part.error : new Error(String(part.error))
              }
              return { text, calls }
            },
            catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
          }).pipe(
            Effect.tapError((error) => store.completeMessage({ id: assistant.id, error: error.message })),
            Effect.orDie,
          )

          if (turn.text.length > 0) {
            yield* store.putPart({
              id: newPartID(),
              messageID: assistant.id,
              sessionID: input.sessionID,
              type: "text",
              text: turn.text,
            })
          }

          if (turn.calls.length === 0) {
            yield* store.completeMessage({ id: assistant.id })
            return false
          }

          yield* settleCalls({ ...input, assistantID: assistant.id, calls: turn.calls })
          yield* store.completeMessage({ id: assistant.id })
          return true
        })

      const settleCalls = (input: {
        readonly sessionID: SessionID
        readonly directory: string
        readonly assistantID: MessageID
        readonly sink: Sink
        readonly calls: readonly { id: string; name: string; input: unknown }[]
      }) =>
        Effect.forEach(
          input.calls,
          (call) =>
            Effect.gen(function* () {
              const partId = newPartID()
              const base = {
                id: partId,
                messageID: input.assistantID,
                sessionID: input.sessionID,
                type: "tool" as const,
                callID: call.id,
                tool: call.name,
                input: call.input,
              }
              yield* store.putPart({ ...base, state: "running" })
              input.sink.tool({ name: call.name, state: "running" })

              const settlement = yield* registry.settle({
                name: call.name,
                input: call.input,
                context: {
                  sessionID: input.sessionID,
                  messageID: input.assistantID,
                  callID: call.id,
                  directory: input.directory,
                  // Per-call abort arrives with interruption support in M2.
                  abort: new AbortController().signal,
                },
              })

              if (!settlement.ok) {
                yield* store.putPart({ ...base, state: "error", error: settlement.error })
                input.sink.tool({ name: call.name, state: "error", title: settlement.error })
                return
              }
              yield* store.putPart({ ...base, state: "completed", output: settlement.result.output })
              input.sink.tool({ name: call.name, state: "completed", title: settlement.result.title })
            }),
          // Sequential: parallel tool calls can touch the same files, and the
          // provider expects results in call order.
          { discard: true },
        )

      const prompt: Interface["prompt"] = (input) =>
        Effect.gen(function* () {
          const session = yield* store.get(input.sessionID).pipe(Effect.orDie)
          const ref = parseModel(input.model)

          // Persisted before any provider work, so a crash cannot lose the ask.
          // M2 turns this into durable admission with steer/queue delivery.
          const user = yield* store.appendMessage({ sessionID: input.sessionID, role: "user" })
          yield* store.putPart({
            id: newPartID(),
            messageID: user.id,
            sessionID: input.sessionID,
            type: "text",
            text: input.text,
          })
          yield* store.completeMessage({ id: user.id })

          let step = 0
          let needsContinuation = true
          while (needsContinuation && step < MAX_STEPS) {
            needsContinuation = yield* runTurn({
              sessionID: input.sessionID,
              directory: session.directory,
              ref,
              sink: input.sink,
            })
            step++
          }
        })

      return SessionRun.of({ prompt })
    }),
  )

/** Production wiring: models come from the provider registry. */
export const layer = layerWith(resolveModel)
