import type { MessageID, SessionID } from "@compass/schema"
import { Data, Effect, JSONSchema, Schema } from "effect"

/**
 * Everything a tool is allowed to know about the turn that invoked it.
 * Kept deliberately small: tools that need more should receive it as input.
 */
export interface Context {
  readonly sessionID: SessionID
  readonly messageID: MessageID
  readonly callID: string
  readonly directory: string
  readonly abort: AbortSignal
}

export class ToolFailure extends Data.TaggedError("ToolFailure")<{ readonly message: string }> {}

export interface Result {
  /** Short human-facing label, shown in the TUI. Not sent to the model. */
  readonly title: string
  /** Model-visible output. Bounded by the registry, never by the tool. */
  readonly output: string
  readonly metadata?: Readonly<Record<string, unknown>>
}

/**
 * The one canonical tool representation. There is deliberately no second
 * executable entry type, registry-owned executor, or authorization callback —
 * opencode's tool/AGENTS.md is emphatic that adding one is the mistake.
 */
export interface Tool<A = any> {
  readonly description: string
  readonly input: Schema.Schema<A, any, never>
  /** Permission action; defaults to the registered name. `edit`/`write` share one. */
  readonly permission?: string
  readonly execute: (input: A, context: Context) => Effect.Effect<Result, ToolFailure>
}

export function make<A>(config: Tool<A>): Tool<A> {
  return config
}

const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
export const validName = (name: string) => NAME.test(name)

/** Model-facing parameter schema. Effect Schema is the single source of truth. */
export function parameters(tool: Tool<any>) {
  return JSONSchema.make(tool.input)
}

export function decode(tool: Tool<any>, input: unknown) {
  return Schema.decodeUnknown(tool.input)(input).pipe(
    Effect.mapError((error) => new ToolFailure({ message: `Invalid tool input: ${error.message}` })),
  )
}
