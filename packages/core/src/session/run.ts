import {
  INCOMPLETE_FINISH,
  partID as newPartID,
  type Admitted,
  type Delivery,
  type CompactionPart,
  type PartID,
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
import { find as findAgent } from "../agent/agent"
import { discover, render } from "../instruction/instruction"
import { Project } from "../project/project"
import { classify, describe as describeProviderError } from "../provider/error"
import { modelLimit, parseModel, resolveModel, type ModelRef } from "../provider/provider"
import { toTokens } from "../provider/usage"
import { ToolRegistry } from "../tool/registry"
import { ToolFailure } from "../tool/tool"
import { parameters } from "../tool/tool"
import {
  DEFAULT_KEEP_TOKENS,
  SUMMARY_OUTPUT_TOKENS,
  buildPrompt,
  lastCompaction,
  select,
  summaryFits,
} from "./compaction"
import { SessionInput } from "./input"
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
  /**
   * The model is thinking. Reasoning models can spend a long time here emitting
   * nothing else, and without this the terminal looks hung.
   */
  /** Which instruction files the session is following. Silent obedience is worse than none. */
  readonly instructions: (paths: readonly string[]) => void
  /**
   * A subagent is running. Its own output is deliberately hidden, so without
   * this the terminal shows a long unexplained pause.
   */
  readonly subagent: (event: {
    readonly state: "started" | "working" | "finished"
    readonly agent: string
    readonly description?: string
    readonly tool?: string
  }) => void
  readonly reasoning: (delta: string) => void
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
  /**
   * The provider stopped before finishing a complete answer — output limit,
   * content filter, or an error mid-generation. Nothing else distinguishes this
   * from a normal reply; the text just stops.
   */
  readonly incomplete: (event: { readonly reason: string; readonly detail: string }) => void
}

export interface RunInput {
  readonly sessionID: SessionID
  readonly text: string
  readonly model?: string
  readonly sink: Sink
  /**
   * When this prompt reaches the model. Defaults to `queue`, which is right for
   * a fresh ask; `steer` is for redirecting work already in flight.
   */
  readonly delivery?: Delivery
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

/** One emitted block of a turn, in the order the model produced it. */
type Block =
  | { kind: "text" | "reasoning"; text: string; metadata?: Record<string, unknown> }
  | { kind: "tool"; callID: string; name: string; input: unknown; error?: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const asRecord = (value: unknown) => (isRecord(value) ? value : undefined)

/**
 * Merges provider metadata one level into the provider namespace.
 *
 * Providers deliver a block's metadata in pieces — OpenAI sends the item id on
 * `reasoning-start` and the encrypted content on a later delta, both under
 * `openai`. A top-level spread replaces that whole namespace and keeps only
 * whichever arrived last. opencode replaces wholesale (processor.ts:298) and
 * gets away with it because Anthropic happens to send metadata only once.
 */
function mergeMetadata(
  current: Record<string, unknown> | undefined,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...current }
  for (const [namespace, value] of Object.entries(incoming)) {
    const existing = merged[namespace]
    merged[namespace] = isRecord(existing) && isRecord(value) ? { ...existing, ...value } : value
  }
  return merged
}

/** The most useful line an unknown thrown value has to offer. */
const errorText = (cause: unknown) =>
  cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "the model sent an unparsable tool call"

/**
 * How deeply delegation nests. One, matching opencode's default: a subagent
 * cannot spawn a subagent, so a delegation is bounded work rather than a tree
 * whose size nobody chose. The `task` permission is force-denied in a child's
 * derived ruleset for the same reason; this is the second lock on that door.
 */
const MAX_SUBAGENT_DEPTH = 1

/** Bounds runaway tool loops. M2 replaces this with a per-agent turn allowance. */
const MAX_STEPS = 40

const SYSTEM = [
  "You are compass, a coding agent running in a terminal.",
  "Use the provided tools to inspect and modify the user's project.",
  "Prefer reading files before editing them. Be concise in your replies.",
].join(" ")

/**
 * The project's own instructions, appended after ours.
 *
 * Last wins on a conflict, and the ordering is the point: a repository's
 * AGENTS.md is more specific than anything generic said here, so it should
 * override rather than be overridden.
 */
const systemPrompt = (instructions: string) => (instructions.length === 0 ? SYSTEM : `${SYSTEM}\n\n${instructions}`)

/** Everything a drain needs. Shared by the top-level path and by subagents. */
interface Turn {
  readonly sessionID: SessionID
  readonly directory: string
  readonly ref: ModelRef
  readonly sink: Sink
  readonly abort: AbortSignal
  readonly instructions: string
}

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
    const tools = entry.parts.filter((part): part is ToolPart => part.type === "tool")

    if (entry.info.role === "user") {
      const text = entry.parts
        .filter((part): part is TextPart => part.type === "text")
        .map((part) => part.text)
        .join("")
      if (text.length > 0) messages.push({ role: "user", content: text })
      continue
    }

    // Walked in stored order, which is emitted order, so a turn that reasoned,
    // called a tool, then explained itself is replayed that way round. The old
    // version partitioned into "all text" then "all calls", which happened to
    // match how ids sorted and so hid the reordering rather than avoiding it.
    const content: Extract<ModelMessage, { role: "assistant" }>["content"] = []
    for (const part of entry.parts) {
      if (part.type === "text") {
        if (part.text.length > 0) content.push({ type: "text", text: part.text })
        continue
      }
      if (part.type === "tool") {
        // A malformed call has the raw argument *string* as its input. Replaying
        // that produces a tool_use whose input is not an object, which providers
        // reject — and the store has no delete, so it would be permanent. The SDK
        // guards the same case when it rebuilds history.
        const input = typeof part.input === "object" && part.input !== null ? part.input : {}
        content.push({ type: "tool-call", toolCallId: part.callID, toolName: part.tool, input })
      }
      // Reasoning is stored and displayed but deliberately not replayed.
      //
      // Sending it back is provider-specific and fails quietly when done wrong:
      // an unsigned Anthropic thinking block is dropped with a warning rather
      // than an error, and OpenAI wants its encrypted content under
      // `providerOptions` on a Responses request. Neither can be verified
      // without a live call, and the cost of omitting it is that the model
      // reasons afresh — tokens, not correctness. Revisit with a real provider
      // to exercise it against.
    }
    if (content.length > 0) messages.push({ role: "assistant", content })

    // Tool results are a separate provider message and must follow the call
    // that produced them, in the same order.
    //
    // Every call gets a result, including ones that never settled. Anthropic and
    // OpenAI both hard-reject an assistant turn carrying a tool_use with no
    // matching tool_result, and that rejection is unrecoverable here: it is
    // classified as a plain api_error so retry declines it, it is not an
    // overflow so compaction never runs, and the store has no delete — so the
    // bad turn is replayed identically on every future prompt and the session is
    // permanently unusable. `reconcile` settles these at the end of a turn, but
    // it is an Effect finalizer and a SIGKILL skips it. This is the layer that
    // makes a stranded part survivable rather than fatal.
    if (tools.length === 0) continue
    messages.push({
      role: "tool",
      content: tools.map((part) => ({
        type: "tool-result" as const,
        toolCallId: part.callID,
        toolName: part.tool,
        output:
          part.state === "completed"
            ? { type: "text" as const, value: part.output ?? "" }
            : {
                type: "error-text" as const,
                value:
                  part.state === "error"
                    ? (part.error ?? "tool failed")
                    : "[Tool execution was interrupted and produced no result]",
              },
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
      const inputs = yield* SessionInput
      const projects = yield* Project
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

      const runTurn = (input: Turn) =>
        Effect.gen(function* () {
          const history = yield* store.messages(input.sessionID)
          const assistant = yield* store.appendMessage({
            sessionID: input.sessionID,
            role: "assistant",
            providerID: input.ref.providerID,
            modelID: input.ref.modelID,
          })

          // Hoisted so an interrupt can persist whatever arrived before it. Reset
          // at the top of each attempt, because the whole stream is retried and a
          // replayed attempt must not inherit the previous one's blocks.
          let blocks: Block[] = []

          const turn = yield* Effect.tryPromise({
            try: async (signal) => {
              blocks = []
              const result = streamText({
                model: resolve(input.ref),
                system: systemPrompt(input.instructions),
                // Interruption reaches the provider through here: Effect fires
                // this signal when the fiber is interrupted, which ends the HTTP
                // request rather than leaving it streaming into a dropped fiber.
                abortSignal: signal,
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
              let tokens: Tokens | undefined
              let finish: string | undefined
              /**
               * Blocks in the order the model emitted them. A turn is genuinely
               * ordered — reason, call a tool, then explain — and flattening it
               * into "all the text" plus "all the calls" loses that.
               */
              /** SDK block id → index in `blocks`, for routing deltas. */
              const open = new Map<string, number>()
              /** Dedupes the pending notice; not every provider emits tool-input-start. */
              const announced = new Set<string>()

              const openBlock = (kind: "text" | "reasoning", id: string, metadata?: Record<string, unknown>) => {
                const existing = open.get(id)
                if (existing !== undefined) return existing
                const index = blocks.push({ kind, text: "", ...(metadata === undefined ? {} : { metadata }) }) - 1
                open.set(id, index)
                return index
              }

              const append = (kind: "text" | "reasoning", id: string, delta: string, metadata?: unknown) => {
                // Belt and braces. The SDK rejects a delta whose block was never
                // opened before it reaches us ("text part <id> not found"), so
                // this cannot currently fire — but opening lazily costs nothing
                // and loses no text, where opencode drops it (processor.ts:296).
                const block = blocks[openBlock(kind, id)]
                if (block === undefined || block.kind === "tool") return
                block.text += delta
                if (isRecord(metadata)) block.metadata = mergeMetadata(block.metadata, metadata)
              }

              for await (const part of result.fullStream) {
                if (part.type === "text-start") {
                  openBlock("text", part.id)
                  continue
                }
                if (part.type === "text-delta") {
                  append("text", part.id, part.text, part.providerMetadata)
                  input.sink.text(part.text)
                  continue
                }
                // Reasoning is stored and shown but never replayed — see
                // toModelMessages. Metadata is merged rather than replaced
                // because providers deliver it in pieces across the block.
                if (part.type === "reasoning-start") {
                  openBlock("reasoning", part.id, asRecord(part.providerMetadata))
                  continue
                }
                if (part.type === "reasoning-delta") {
                  append("reasoning", part.id, part.text, part.providerMetadata)
                  input.sink.reasoning(part.text)
                  continue
                }
                if (part.type === "reasoning-end") {
                  append("reasoning", part.id, "", part.providerMetadata)
                  continue
                }
                if (part.type === "text-end") continue
                // The model has committed to a tool name; the argument JSON is
                // still streaming. For a large write or edit that gap runs to
                // seconds, and until now nothing was shown for any of it — the
                // tool line appeared only once the whole stream had drained.
                // In-memory and sink-only: persisting here would reintroduce the
                // retry double-write the comment below exists to prevent.
                if (part.type === "tool-input-start") {
                  if (!announced.has(part.id)) {
                    announced.add(part.id)
                    input.sink.tool({ name: part.toolName, state: "pending" })
                  }
                  continue
                }
                // An abort is not an error in the AI SDK — it ends `fullStream`
                // cleanly, so without this a cancelled turn would look like a
                // short but successful one and be persisted as a real reply.
                if (part.type === "abort") throw new Error(part.reason ?? "The turn was aborted")
                if (part.type === "tool-call") {
                  // The SDK flags a call whose arguments would not parse and
                  // hands back the raw string plus an InvalidToolInputError that
                  // names the offending field. Running it through the registry
                  // would discard that for a vaguer decoder message and cost a
                  // pointless dispatch for what may be a hallucinated tool.
                  const invalid = part.invalid === true
                  blocks.push({
                    kind: "tool",
                    callID: part.toolCallId,
                    name: part.toolName,
                    input: part.input,
                    ...(invalid ? { error: errorText(part.error) } : {}),
                  })
                  continue
                }
                // Paired with an invalid tool-call, which already carried the
                // error. Skipped rather than handled twice.
                if (part.type === "tool-error") continue
                // The provider's own accounting, and the only trustworthy input
                // to overflow detection. Read here rather than awaited off the
                // result promise so a stream that errors partway still leaves
                // whatever it had reported.
                if (part.type === "finish") {
                  tokens = toTokens(part.totalUsage)
                  finish = part.finishReason
                  continue
                }
                if (part.type === "error")
                  throw part.error instanceof Error ? part.error : new Error(String(part.error))
              }
              return { blocks, tokens, finish }
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
            // Interruption is a cause, not a failure, so neither the retry
            // schedule nor tapError sees it — which is right, but it also means
            // nothing would otherwise close the message out. Whatever streamed
            // before the interrupt is real and the user watched it arrive, so it
            // is kept rather than discarded.
            Effect.onInterrupt(() =>
              Effect.gen(function* () {
                yield* persistBlocks(blocks, assistant.id, input.sessionID)
                yield* store.completeMessage({ id: assistant.id, error: "Interrupted", finish: "abort" })
              }).pipe(Effect.ignore),
            ),
            Effect.tapError((error) => store.completeMessage({ id: assistant.id, error: error.message })),
            Effect.mapError(
              (error) =>
                new ProviderFailure({
                  ...describeProviderError(error),
                  ...(classify(error).type === "context_overflow" ? { overflow: true } : {}),
                }),
            ),
          )

          // IDs are minted here, in block order, and never during the stream.
          // (see persistBlocks for the same rule applied on the interrupt path)
          // Part IDs are monotonic ULIDs and both parts and messages are read
          // back sorted by id, so minting in order is what makes stored order
          // equal emitted order. Minting tool IDs later — as this did until now,
          // inside settleCalls — sorted every tool part after every text part
          // and silently reordered the turn.
          const ordered = turn.blocks.map((block) => ({ ...block, partID: newPartID() }))

          for (const block of ordered) {
            if (block.kind === "tool") continue
            if (block.text.length === 0) continue
            yield* store.putPart({
              id: block.partID,
              messageID: assistant.id,
              sessionID: input.sessionID,
              type: block.kind,
              text: block.text,
              ...(block.kind === "reasoning" && block.metadata !== undefined ? { metadata: block.metadata } : {}),
            })
          }

          const calls = ordered.flatMap((block) =>
            block.kind === "tool"
              ? [
                  {
                    partID: block.partID,
                    id: block.callID,
                    name: block.name,
                    input: block.input,
                    ...(block.error === undefined ? {} : { error: block.error }),
                  },
                ]
              : [],
          )

          const settled = {
            id: assistant.id,
            ...(turn.tokens === undefined ? {} : { tokens: turn.tokens }),
            ...(turn.finish === undefined ? {} : { finish: turn.finish }),
          }

          // A reply cut off at the output limit, refused by a content filter, or
          // abandoned mid-generation is not a complete answer. Nothing else in
          // the loop can tell — the text simply stops — so it is said plainly
          // here rather than left for the user to infer from a sentence that
          // ends mid-word.
          const incomplete = turn.finish === undefined ? undefined : INCOMPLETE_FINISH[turn.finish]
          if (incomplete !== undefined) input.sink.incomplete({ reason: turn.finish!, detail: incomplete })

          if (calls.length === 0) {
            yield* store.completeMessage(settled)
            return false
          }

          yield* settleCalls({ ...input, assistantID: assistant.id, calls })
          yield* store.completeMessage(settled)
          // Tool calls were made, so normally the model gets their results back.
          // Not when the provider stopped for a reason that makes continuing
          // pointless: a reply truncated at the output limit will truncate
          // again, and a filtered one will filter again.
          return incomplete === undefined
        })

      const settleCalls = (
        input: Turn & {
          readonly sessionID: SessionID
          readonly directory: string
          readonly assistantID: MessageID
          readonly sink: Sink
          readonly calls: readonly { partID: PartID; id: string; name: string; input: unknown; error?: string }[]
        },
      ) =>
        Effect.forEach(
          input.calls,
          (call) =>
            Effect.gen(function* () {
              const base = {
                id: call.partID,
                messageID: input.assistantID,
                sessionID: input.sessionID,
                type: "tool" as const,
                callID: call.id,
                tool: call.name,
                input: call.input,
              }
              // Already known bad before dispatch: record it and let the model
              // see the error so it can correct itself on the next turn.
              if (call.error !== undefined) {
                yield* store.putPart({ ...base, state: "error", error: call.error })
                input.sink.tool({ name: call.name, state: "error", title: call.error })
                return
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
                  abort: input.abort,
                  // Closes over this turn, so a child inherits its directory,
                  // model and abort signal without any of it being global.
                  spawn: spawn(input),
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
        ).pipe(
          // Every tool part is written `running` before execution, so anything
          // that stops settleCalls part-way — a defect, an interrupt, the
          // process dying — leaves parts claiming to be in flight forever.
          // Nothing later ever revisits them: toModelMessages skips unsettled
          // parts, so the model is shown a call with no result and silently
          // loses the fact that it ever ran.
          Effect.onExit(() => reconcile({ sessionID: input.sessionID, assistantID: input.assistantID })),
        )

      /** Forces any still-running tool part of this message into a terminal state. */
      const reconcile = (input: { readonly sessionID: SessionID; readonly assistantID: MessageID }) =>
        Effect.gen(function* () {
          const parts = yield* store.parts(input.assistantID)
          for (const part of parts) {
            if (part.type !== "tool" || (part.state !== "running" && part.state !== "pending")) continue
            yield* store.putPart({ ...part, state: "error", error: "Tool execution was interrupted" })
          }
        }).pipe(Effect.ignore)

      /**
       * Replaces the older half of the conversation with a summary.
       *
       * Runs as its own provider call with no tools — the summarizer has one
       * job and giving it tools invites it to go and do the work instead.
       * Returns false whenever compaction cannot help, and never throws: a
       * failed compaction must leave the session exactly as it was, because the
       * alternative is losing a conversation in the process of saving it.
       */
      const compact = (input: Omit<Turn, "directory" | "instructions">) =>
        Effect.gen(function* () {
          const history = yield* store.messages(input.sessionID)
          const previous = lastCompaction(history)

          // Only what has happened since the last boundary. Everything older was
          // already replaced by `prior.summary`, and feeding it back in would
          // make each compaction larger than the one before it — the opposite of
          // the point, and large enough by the second or third to fail the
          // summaryFits guard and stop compacting at all.
          const since = previous === undefined ? history : history.slice(previous.index + 1)
          const selected = select(since, DEFAULT_KEEP_TOKENS)
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
            try: async (signal) => {
              const result = streamText({
                model: resolve(input.ref),
                messages: [{ role: "user", content: summaryPrompt }],
                abortSignal: signal,
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

      /**
       * Writes text and reasoning blocks as parts, in order.
       *
       * Ids are minted here rather than during the stream, in array order —
       * they are monotonic ULIDs and parts are read back sorted by id, so
       * minting in order is what makes stored order equal emitted order.
       */
      const persistBlocks = (blocks: readonly Block[], messageID: MessageID, sessionID: SessionID) =>
        Effect.forEach(
          blocks.filter((block) => block.kind !== "tool" && block.text.length > 0),
          (block) =>
            store.putPart({
              id: newPartID(),
              messageID,
              sessionID,
              type: block.kind as "text" | "reasoning",
              text: (block as { text: string }).text,
              ...(block.kind === "reasoning" && block.metadata !== undefined ? { metadata: block.metadata } : {}),
            }),
          { discard: true },
        )

      /**
       * Turns a promoted prompt into a user message the model will see.
       *
       * The admitted record keeps its own id and the message adopts it, so the
       * durable prompt and the conversation entry are the same thing rather than
       * two rows that have to be kept in agreement.
       */
      const materialize = (admitted: Admitted) =>
        Effect.gen(function* () {
          const user = yield* store.appendMessage({
            sessionID: admitted.sessionID,
            role: "user",
            id: admitted.id,
          })
          yield* store.putPart({
            id: newPartID(),
            messageID: user.id,
            sessionID: admitted.sessionID,
            type: "text",
            text: admitted.prompt.text,
          })
          yield* store.completeMessage({ id: user.id })
        })

      /**
       * Works a session until nothing is pending, assuming its prompt is
       * already admitted.
       *
       * Shared by the top-level entrypoint and by subagents, which is the
       * point: a child session is not a second runtime, it is this one called
       * again. Compaction, retry, steering and interruption therefore apply to
       * a subagent by construction rather than by a parallel implementation
       * somebody has to remember to keep in step.
       */
      const drain = (turn: Turn): Effect.Effect<void, ProviderFailure> =>
        Effect.gen(function* () {
          // Anything already waiting joins this drain — a steer admitted while
          // the session was idle should not sit until the next prompt.
          const initial = yield* inputs.promoteSteers(turn.sessionID, yield* inputs.highWater(turn.sessionID))
          for (const admitted of initial) yield* materialize(admitted)
          const first = yield* inputs.promoteNextQueued(turn.sessionID)
          if (first !== undefined) yield* materialize(first)
          if (initial.length === 0 && first === undefined) return

          let step = 0
          let shouldRun = true
          while (shouldRun) {
            let needsContinuation = true
            while (needsContinuation && step < MAX_STEPS) {
              // Reactive path. The provider is the only authority on what fits, so
              // an overflow it reports is compacted and the turn retried once.
              // `retryable` deliberately refuses to retry these, because a plain
              // retry re-sends the same oversized input — this retries a *smaller*
              // one, which is a different thing.
              const outcome = yield* Effect.result(runTurn(turn))
              // Counted before the recovery branch, and again after it, so both
              // the failed turn and its retry charge against the cap — otherwise
              // a session overflowing on every pass gets two turns per iteration
              // and reaches 2 × MAX_STEPS worth of work.
              //
              // Summarizer calls are deliberately NOT charged. The cap bounds
              // agent steps, not provider calls; charging compaction would give an
              // overflowing session fewer real steps than a clean one, and in the
              // recovery branch could trip the break below immediately after
              // paying for a summary — abandoning the turn having gained nothing.
              step++
              if (outcome._tag === "Failure") {
                const failure = outcome.failure
                if (failure.overflow !== true || !(yield* compact(turn))) return yield* Effect.fail(failure)
                if (step >= MAX_STEPS) break
                needsContinuation = yield* runTurn(turn)
                step++
              } else {
                needsContinuation = outcome.success
              }

              // Proactive path. Compacting between turns keeps the next request
              // inside the window instead of discovering the limit by failing.
              const history = yield* store.messages(turn.sessionID)
              const tokens = history.at(-1)?.info.tokens
              if (isOverflow({ tokens, limit: modelLimit(turn.ref) })) yield* compact(turn)

              // A safe turn boundary: the model has finished a thought and no tool
              // is mid-flight. Steers land here and nowhere else, which is what
              // makes "actually, use the other file" arrive without interleaving
              // into a half-finished tool sequence.
              if (!needsContinuation) {
                // The cutoff is read here, at the boundary, not before the turn.
                // Everything admitted while the turn ran belongs to this
                // boundary; only what lands during promotion itself waits for
                // the next one, which is what stops a steady stream of steers
                // from looping here forever. opencode reads its cutoff at the
                // same instant (runner/llm.ts:188).
                const cutoff = yield* inputs.highWater(turn.sessionID)
                const steers = yield* inputs.promoteSteers(turn.sessionID, cutoff)
                if (steers.length > 0) {
                  for (const admitted of steers) yield* materialize(admitted)
                  needsContinuation = true
                  // New instruction, fresh allowance — a batch resets it once, not
                  // once per steer, so a burst cannot buy unbounded steps.
                  step = 0
                }
              }
            }

            // Hitting the cap mid-task looks exactly like finishing: the loop
            // returns, the CLI exits 0, and the reply simply stops. Say so, the
            // same way a truncated reply is reported.
            if (needsContinuation && step >= MAX_STEPS) {
              turn.sink.incomplete({
                reason: "step-limit",
                detail: `the turn reached its limit of ${MAX_STEPS} steps and stopped before finishing`,
              })
              return
            }

            // Idle. Exactly one queued prompt promotes, so a backlog is worked
            // through one at a time rather than concatenated into a single turn.
            const next = yield* inputs.promoteNextQueued(turn.sessionID)
            shouldRun = next !== undefined
            if (next !== undefined) {
              yield* materialize(next)
              step = 0
            }
          }
        })

      /** How deep in the parent chain a session sits. Zero for a top-level one. */
      const depthOf = (sessionID: SessionID) =>
        Effect.gen(function* () {
          let depth = 0
          let current = yield* store.get(sessionID).pipe(Effect.orDie)
          while (current.parentID !== undefined && depth <= MAX_SUBAGENT_DEPTH) {
            depth++
            current = yield* store.get(current.parentID).pipe(Effect.orDie)
          }
          return depth
        })

      /**
       * Runs a prompt in a child session and returns its final answer.
       *
       * A subagent is a child Session, not a second runtime — it calls the same
       * drain, writes to the same tables, and is subject to the same retry,
       * compaction and interruption. The only things that differ are its system
       * prompt and the fact that its intermediate turns never surface.
       */
      const spawn =
        (parent: Turn) =>
        (request: { agent: string; description: string; prompt: string }): Effect.Effect<string, ToolFailure> =>
          Effect.gen(function* () {
            const depth = yield* depthOf(parent.sessionID)
            if (depth >= MAX_SUBAGENT_DEPTH) {
              return yield* new ToolFailure({
                message: `Delegation only nests ${MAX_SUBAGENT_DEPTH} deep, and this session is already a subagent.`,
              })
            }

            const definition = findAgent(parent.directory, request.agent)
            if (definition === undefined) {
              return yield* new ToolFailure({ message: `Unknown agent "${request.agent}".` })
            }

            const child = yield* store.create({
              title: request.description,
              directory: parent.directory,
              parentID: parent.sessionID,
            })
            parent.sink.subagent({ state: "started", agent: request.agent, description: request.description })

            yield* inputs.admit({ sessionID: child.id, prompt: { text: request.prompt }, delivery: "queue" })

            // The child streams into its own session, not the parent's terminal.
            // Hiding that detail is the entire reason to delegate; only tool
            // activity is surfaced, so the wait is legible.
            const quiet: Sink = {
              text: () => {},
              reasoning: () => {},
              tool: (event) =>
                event.state === "pending"
                  ? parent.sink.subagent({ state: "working", agent: request.agent, tool: event.name })
                  : undefined,
              retry: parent.sink.retry,
              compaction: parent.sink.compaction,
              incomplete: parent.sink.incomplete,
              instructions: () => {},
              subagent: () => {},
            }

            const outcome = yield* Effect.result(
              drain({
                sessionID: child.id,
                directory: parent.directory,
                ref: parent.ref,
                sink: quiet,
                abort: parent.abort,
                // The agent's own prompt replaces the primary one; the project's
                // instructions still apply, since the child works in the same repo.
                instructions: [definition.prompt, parent.instructions].filter(Boolean).join("\n\n"),
              }),
            )

            parent.sink.subagent({ state: "finished", agent: request.agent, description: request.description })
            if (outcome._tag === "Failure") {
              return yield* new ToolFailure({
                message: `The ${request.agent} agent failed: ${outcome.failure.message}`,
              })
            }

            // Only the last thing it said. Everything before that is the working
            // out, which stays on disk and out of the parent's context.
            const answer = (yield* store.messages(child.id))
              .filter((entry) => entry.info.role === "assistant")
              .flatMap((entry) => entry.parts)
              .filter((part): part is TextPart => part.type === "text")
              .map((part) => part.text)
              .at(-1)

            if (answer === undefined || answer.trim().length === 0) {
              return yield* new ToolFailure({ message: `The ${request.agent} agent returned nothing.` })
            }
            return answer
          })

      const prompt: Interface["prompt"] = (input) =>
        Effect.suspend(() => {
          // One controller for the whole drain, created before the body so the
          // interrupt hook below can reach it.
          const controller = new AbortController()
          return Effect.gen(function* () {
            const session = yield* store.get(input.sessionID).pipe(Effect.orDie)
            const ref = parseModel(input.model)

            // Durable first, executed second. A crash between these two loses
            // nothing: the prompt is on disk and the next drain picks it up.
            yield* inputs.admit({
              sessionID: input.sessionID,
              prompt: { text: input.text, ...(input.model === undefined ? {} : { model: input.model }) },
              delivery: input.delivery ?? "queue",
            })

            // Read once per drain rather than per turn. Once is enough to pick
            // up an edit made between prompts, and forty filesystem walks for a
            // file that has not changed is forty walks wasted.
            const project = yield* projects.resolve(session.directory)
            const files = discover({ directory: session.directory, project: project.directory })
            if (files.length > 0) input.sink.instructions(files.map((file) => file.path))

            yield* drain({
              sessionID: input.sessionID,
              directory: session.directory,
              ref,
              sink: input.sink,
              abort: controller.signal,
              instructions: render(files),
            })
          }).pipe(
            // Effect can end its own promises on interruption, but a tool already
            // executing is a promise the runtime cannot reach into — bash has a
            // child process, read has an open handle. Firing the controller is how
            // they are told, and it is the same signal the provider call uses, so
            // one Ctrl-C stops everything rather than the visible half.
            Effect.onInterrupt(() => Effect.sync(() => controller.abort())),
          )
        })

      return SessionRun.of({ prompt })
    }),
  )

/** Production wiring: models come from the provider registry. */
export const layer = layerWith(resolveModel)
