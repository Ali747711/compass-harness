import type { MessageID, SessionID } from "@compass/schema"
import { Data, Effect, JsonSchema, Schema } from "effect"

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
  readonly input: Schema.Codec<A, any, never, never>
  /** Permission action; defaults to the registered name. `edit`/`write` share one. */
  readonly permission?: string
  readonly execute: (input: A, context: Context) => Effect.Effect<Result, ToolFailure>
}

export function make<A>(config: Tool<A>): Tool<A> {
  return config
}

const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
export const validName = (name: string) => NAME.test(name)

type JsonObject = Record<string, unknown>

const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** A branch can only be hoisted when none of its keys already exist on the parent or a sibling branch. */
function canFlatten(branches: readonly JsonObject[], parent: JsonObject) {
  const keys = new Set(Object.keys(parent).filter((key) => key !== "allOf"))
  return branches.every((branch) =>
    Object.keys(branch).every((key) => {
      if (keys.has(key)) return false
      keys.add(key)
      return true
    }),
  )
}

/**
 * Schema checks are emitted as an `allOf` branch (`{type:"integer",allOf:[{minimum:1,description:"…"}]}`),
 * which buries the field's description one level below where a model looks for it
 * and which some providers reject outright. A branch that collides with nothing is
 * folded back into its parent, leaving the flat document tools have always exposed.
 */
function flattenChecks(schema: JsonObject): JsonObject {
  const walked = Object.fromEntries(Object.entries(schema).map(([key, item]) => [key, walk(item)]))
  const branches = walked.allOf
  if (!Array.isArray(branches) || !branches.every(isRecord)) return walked
  if (!canFlatten(branches, walked)) return walked
  const { allOf: _hoisted, ...rest } = walked
  return { ...Object.assign({}, ...branches), ...rest }
}

function walk(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(walk)
  if (isRecord(value)) return flattenChecks(value)
  return value
}

/** Model-facing parameter schema. Effect Schema is the single source of truth. */
export function parameters(tool: Tool<any>): JsonObject {
  const document = JsonSchema.toDocumentDraft07(Schema.toJsonSchemaDocument(tool.input))
  return flattenChecks({
    $schema: JsonSchema.META_SCHEMA_URI_DRAFT_07,
    ...document.schema,
    ...(Object.keys(document.definitions).length > 0 ? { $defs: document.definitions } : {}),
  })
}

export function decode(tool: Tool<any>, input: unknown) {
  return Schema.decodeUnknownEffect(tool.input)(input).pipe(
    Effect.mapError((error) => new ToolFailure({ message: `Invalid tool input: ${error.message}` })),
  )
}
