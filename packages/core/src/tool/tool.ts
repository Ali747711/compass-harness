import type { MessageID, SessionID } from "@compass/schema"
import type { PermissionDenied, Request as PermissionRequest } from "../permission/permission"
import { Data, Effect, JsonSchema, Schema } from "effect"

/**
 * Everything a tool is allowed to know about the turn that invoked it.
 * Kept deliberately small: tools that need more should receive it as input.
 */
export interface Context {
  readonly sessionID: SessionID
  readonly messageID: MessageID
  /**
   * Requests authorization before a side effect. Fails when refused, and the
   * tool must propagate that rather than proceeding. Supplied by the registry
   * from the Permission service, so a tool never reaches the policy directly.
   */
  readonly ask: (request: PermissionRequest) => Effect.Effect<void, PermissionDenied>
  readonly callID: string
  readonly directory: string
  readonly abort: AbortSignal
  /**
   * Runs a prompt in a child session and returns its answer.
   *
   * Travels on the call context rather than through a service because the
   * runner is what supplies it, and the runner already depends on the tool
   * registry — a `task` tool that depended on the runner would close that loop.
   * Absent when no runner is present, which is why it is optional: a tool test
   * builds a context by hand and has nothing to spawn into.
   */
  readonly spawn?: (input: {
    readonly agent: string
    readonly description: string
    readonly prompt: string
  }) => Effect.Effect<string, ToolFailure>
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

/**
 * Fills {{TOKEN}} placeholders in a description loaded from a .txt file.
 *
 * Descriptions live as prose so they are reviewable as prose, but several state
 * limits that are real constants in the code. Baking the numbers into the text
 * would create a second source of truth beside the parameter schema, which
 * still interpolates the live value — so a later change to a constant would
 * tell the model two different things with nothing to catch it.
 */
export function render(text: string, values: Readonly<Record<string, string | number>>) {
  return text.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    const value = values[key]
    if (value === undefined) throw new Error(`Unknown description placeholder: ${match}`)
    return String(value)
  })
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
