import { Context, Data, Effect, Layer } from "effect"

export class PermissionDenied extends Data.TaggedError("PermissionDenied")<{
  readonly permission: string
  readonly pattern: string
}> {
  override get message() {
    return `Permission denied: ${this.permission} (${this.pattern})`
  }
}

export interface Request {
  /** Action name. Defaults to the tool's registered name; `edit`/`write` share `edit`. */
  readonly permission: string
  /** Concrete patterns being requested, e.g. a directory glob or a command prefix. */
  readonly patterns: readonly string[]
  /** Patterns to remember if the user answers "always". */
  readonly always?: readonly string[]
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface Interface {
  /** Succeeds when allowed, fails with PermissionDenied when refused. */
  readonly ask: (request: Request) => Effect.Effect<void, PermissionDenied>
}

export class Permission extends Context.Service<Permission, Interface>()("compass/Permission") {}

/**
 * Interim implementation. The ruleset engine — config-driven allow/deny/ask
 * patterns, persisted decisions, and a TUI prompt — arrives with M6. Until then
 * every request is granted, and the seam exists so tools can be written against
 * the real contract now rather than retrofitted later.
 */
export const layerAllowAll = Layer.sync(Permission, () =>
  Permission.of({
    ask: () => Effect.void,
  }),
)

/** Denies everything. For tests that assert a tool honors refusal. */
export const layerDenyAll = Layer.sync(Permission, () =>
  Permission.of({
    ask: (request) => new PermissionDenied({ permission: request.permission, pattern: request.patterns[0] ?? "*" }),
  }),
)

/** Records every request. For tests that assert a tool asks before acting. */
export const layerRecording = (log: Request[]) =>
  Layer.sync(Permission, () =>
    Permission.of({
      ask: (request) =>
        Effect.sync(() => {
          log.push(request)
        }),
    }),
  )

export * as PermissionModule from "./permission"
