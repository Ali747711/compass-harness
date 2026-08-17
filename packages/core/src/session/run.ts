import {
  partID as newPartID,
  type CompactionPart,
  type MessageID,
  type Part,
  type SessionID,
  type TextPart,
  type Tokens,
  type ToolPart,
} from "@compass/schema"
import { jsonSchema, streamText, tool as aiTool, type LanguageModel, type ModelMessage, type ToolSet } from "ai"
import { Context, Data, Effect, Layer } from "effect"
import { prune } from "../context/pipeline"
import { classify, describe as describeProviderError } from "../provider/error"
import { modelLimit, parseModel, resolveModel, type ModelRef } from "../provider/provider"
import { toTokens } from "../provider/usage"
import { ToolRegistry } from "../tool/registry"
import { parameters } from "../tool/tool"
import {
  DEFAULT_KEEP_TOKENS,
  SUMMARY_OUTPUT_TOKENS,
  buildPrompt,
  lastCompaction,
  select,
  summaryFits,
} from "./compaction"
import { isOverflow } from "./overflow"
import { policy, type Attempt } from "./retry"
import { SessionStore } from "./store"

/**
 * Where streamed activity goes. M0 printed to stdout; M3 replaces this with the
 * durable event stream so TUI and `serve` clients observe the same thing.
 */
export interface Sink {
  readonly text: (delta: string) => void
  readonly tool: (event: { readonly name: string; readonly state: ToolPart["state"]; readonly title?: string }) => void
  /**
   * A transient provider failure is being waited out. Reported rather than
   * hidden: a silent 30-second backoff is indistinguishable from a hang, and
   * the retry replays the turn, so any text already streamed will appear twice
   * unless something marks the boundary.
   */
  readonly retry: (attempt: Attempt) => void
  /**
   * The conversation is being summarized. Worth saying out loud: it costs a
   * provider call, it takes a noticeable pause, and it silently changes what
   * the model can still remember.
   */
  readonly compaction: (event: {
    readonly state: "started" | "completed" | "skipped"
    readonly reason?: string
  }) => void
}

export interface RunInput {
  readonly sessionID: SessionID
  readonly text: string
  readonly model?: string
  readonly sink: Sink
}

/**
 * A provider call that failed for a reason the user can act on — a bad key, a
 * rate limit, a network drop.
 *
 * These used to be Effect.orDie, which made them defects. A defect propagates
 * as a FiberFailure whose message is the entire pretty-printed cause, so an
 * invalid API key printed a stack trace and the full request body, system
 * prompt included, instead of one line saying the key was rejected.
 */
export class ProviderFailure extends Data.TaggedError("ProviderFailure")<{
  readonly message: string
  readonly status?: number
  /** The input did not fit. Compaction can fix this; a plain retry cannot. */
  readonly overflow?: boolean
}> {}

export interface Interface {
  readonly prompt: (input: RunInput) => Effect.Effect<void, ProviderFailure>
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

  // A compaction replaces everything before it. The originals stay on disk —
  // this only changes what the provider is shown — so the boundary is applied
  // here at rebuild time rather than by deleting anything.
  const boundary = lastCompaction(history)
  const entries = boundary === undefined ? history : history.slice(boundary.index + 1)
  if (boundary !== undefined) {
    const part = boundary.part as CompactionPart
    messages.push({
      role: "user",
      content: [
        "This conversation was compacted. Here is a summary of everything before this point:",
        part.summary,
        ...(part.recent ? ["The most recent exchanges follow verbatim:", part.recent] : []),
      ].join("\n\n"),
    })
  }

  for (const entry of entries) {
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
                // The SDK retries twice by default, underneath us and invisibly.
                // That second policy is worse than ours in every respect: it
                // re-sends prompts the provider rejected as too long, ignores
                // Retry-After, reports nothing to the user, and multiplies our
                // own attempts rather than composing with them — six real calls
                // where the schedule intended two. opencode sets this to 0 for
                // the same reason (session/llm.ts:323); retry policy belongs in
                // one place, and this is not it.
                maxRetries: 0,
                // The SDK's default onError is `console.error(error)`, which dumps
                // the whole cause — request body and system prompt included — to
                // the terminal. The error is surfaced from fullStream below, so
                // this replaces a duplicate log rather than swallowing anything.
                onError: () => {},
              })
              let text = ""
              let tokens: Tokens | undefined
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
                // The provider's own accounting, and the only trustworthy input
                // to overflow detection. Read here rather than awaited off the
                // result promise so a stream that errors partway still leaves
                // whatever it had reported.
                if (part.type === "finish") {
                  tokens = toTokens(part.totalUsage)
                  continue
                }
                if (part.type === "error")
                  throw part.error instanceof Error ? part.error : new Error(String(part.error))
              }
              return { text, calls, tokens }
            },
            catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
          }).pipe(
            // Retry first, and only then record the failure. A 503 on the first
            // attempt that succeeds on the second is not an error the session
            // should remember — marking the message failed before the schedule
            // has given up would persist a defeat that never happened.
            //
            // The whole stream consumption is inside the retried effect, so an
            // attempt starts from a clean `text`/`calls` pair rather than
            // resuming a half-read stream. Nothing has been persisted at this
            // point either, so a replay cannot double-write parts.
            Effect.retry(policy((attempt) => Effect.sync(() => input.sink.retry(attempt)))),
            Effect.tapError((error) => store.completeMessage({ id: assistant.id, error: error.message })),
            Effect.mapError(
              (error) =>
                new ProviderFailure({
                  ...describeProviderError(error),
                  ...(classify(error).type === "context_overflow" ? { overflow: true } : {}),
                }),
            ),
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

          const settled = turn.tokens === undefined ? { id: assistant.id } : { id: assistant.id, tokens: turn.tokens }

          if (turn.calls.length === 0) {
            yield* store.completeMessage(settled)
            return false
          }

          yield* settleCalls({ ...input, assistantID: assistant.id, calls: turn.calls })
          yield* store.completeMessage(settled)
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

      /**
       * Replaces the older half of the conversation with a summary.
       *
       * Runs as its own provider call with no tools — the summarizer has one
       * job and giving it tools invites it to go and do the work instead.
       * Returns false whenever compaction cannot help, and never throws: a
       * failed compaction must leave the session exactly as it was, because the
       * alternative is losing a conversation in the process of saving it.
       */
      const compact = (input: { readonly sessionID: SessionID; readonly ref: ModelRef; readonly sink: Sink }) =>
        Effect.gen(function* () {
          const history = yield* store.messages(input.sessionID)
          const previous = lastCompaction(history)
          const selected = select(history, DEFAULT_KEEP_TOKENS)
          if (selected === undefined) return false

          const prior = previous === undefined ? undefined : (previous.part as CompactionPart)
          // Nothing older than the kept tail, and no prior summary to fold in:
          // there is nothing for a summary to remove.
          if (selected.head.length === 0 && prior === undefined) return false

          const summaryPrompt = buildPrompt({
            ...(prior === undefined ? {} : { previousSummary: prior.summary }),
            context: [prior?.recent ?? "", selected.head].filter(Boolean),
          })

          const limit = modelLimit(input.ref)
          // The circular failure this avoids: compaction runs because context is
          // full, and its prompt is built from that same context.
          if (!summaryFits(summaryPrompt, limit)) {
            input.sink.compaction({ state: "skipped", reason: "the conversation is too large to summarize" })
            return false
          }

          input.sink.compaction({ state: "started" })
          const summary = yield* Effect.tryPromise({
            try: async () => {
              const result = streamText({
                model: resolve(input.ref),
                messages: [{ role: "user", content: summaryPrompt }],
                maxRetries: 0,
                maxOutputTokens: SUMMARY_OUTPUT_TOKENS,
                onError: () => {},
              })
              let text = ""
              for await (const part of result.fullStream) {
                if (part.type === "text-delta") text += part.text
                if (part.type === "error")
                  throw part.error instanceof Error ? part.error : new Error(String(part.error))
              }
              return text
            },
            catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
          }).pipe(
            Effect.retry(policy((attempt) => Effect.sync(() => input.sink.retry(attempt)))),
            // A compaction that fails leaves the session untouched rather than
            // taking the turn down with it.
            Effect.catch(() => Effect.succeed("")),
          )

          if (summary.trim().length === 0) {
            input.sink.compaction({ state: "skipped", reason: "the summary came back empty" })
            return false
          }

          const marker = yield* store.appendMessage({
            sessionID: input.sessionID,
            role: "assistant",
            providerID: input.ref.providerID,
            modelID: input.ref.modelID,
          })
          yield* store.putPart({
            id: newPartID(),
            messageID: marker.id,
            sessionID: input.sessionID,
            type: "compaction",
            summary,
            recent: selected.recent,
          })
          yield* store.completeMessage({ id: marker.id })
          input.sink.compaction({ state: "completed" })
          return true
        })

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

          const turn = { sessionID: input.sessionID, directory: session.directory, ref, sink: input.sink }

          let step = 0
          let needsContinuation = true
          while (needsContinuation && step < MAX_STEPS) {
            // Reactive path. The provider is the only authority on what fits, so
            // an overflow it reports is compacted and the turn retried once.
            // `retryable` deliberately refuses to retry these, because a plain
            // retry re-sends the same oversized input — this retries a *smaller*
            // one, which is a different thing.
            const outcome = yield* Effect.result(runTurn(turn))
            if (outcome._tag === "Failure") {
              const failure = outcome.failure
              if (failure.overflow !== true || !(yield* compact(turn))) return yield* Effect.fail(failure)
              needsContinuation = yield* runTurn(turn)
            } else {
              needsContinuation = outcome.success
            }
            step++

            // Proactive path. Compacting between turns keeps the next request
            // inside the window instead of discovering the limit by failing.
            const history = yield* store.messages(input.sessionID)
            const tokens = history.at(-1)?.info.tokens
            if (isOverflow({ tokens, limit: modelLimit(ref) })) yield* compact(turn)
          }
        })

      return SessionRun.of({ prompt })
    }),
  )

/** Production wiring: models come from the provider registry. */
export const layer = layerWith(resolveModel)
