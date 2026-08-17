import { Context as EffectContext, Effect, Layer, Result as EffectResult } from "effect"
import { Permission, type Interface as PermissionService } from "../permission/permission"
import type { Ruleset } from "../permission/ruleset"
import { Spill } from "./spill"
import { bound, exceeds } from "./truncate"
import { ToolFailure, decode, validName, type Context, type Result, type Tool } from "./tool"

/**
 * What a caller supplies. `ask` is injected by the registry from the Permission
 * service, so the runner never touches policy and no tool can bypass it.
 */
export type CallContext = Omit<Context, "ask"> & {
  /** Rules for this session only, forwarded to Permission with every request. */
  readonly ruleset?: Ruleset
}

export interface Registration {
  readonly name: string
  readonly tool: Tool<any>
}

export type Settlement = { readonly ok: true; readonly result: Result } | { readonly ok: false; readonly error: string }

export interface Interface {
  readonly list: () => readonly Registration[]
  readonly get: (name: string) => Tool<any> | undefined
  /**
   * The single execution and output-bounding boundary. Tools return complete
   * output; bounding happens here so no tool can opt out of it.
   */
  readonly settle: (input: {
    readonly name: string
    readonly input: unknown
    readonly context: CallContext
  }) => Effect.Effect<Settlement>
}

export class ToolRegistry extends EffectContext.Service<ToolRegistry, Interface>()("compass/ToolRegistry") {}

export function make(registrations: readonly Registration[], permission: PermissionService): Interface {
  const byName = new Map<string, Tool<any>>()
  for (const entry of registrations) {
    if (!validName(entry.name)) throw new Error(`Invalid tool name: ${entry.name}`)
    if (byName.has(entry.name)) throw new Error(`Duplicate tool registration: ${entry.name}`)
    byName.set(entry.name, entry.tool)
  }

  return {
    list: () => registrations,
    get: (name) => byName.get(name),
    settle: (input) =>
      Effect.gen(function* () {
        const tool = byName.get(input.name)
        if (!tool) return { ok: false as const, error: `Unknown tool: ${input.name}` }

        // The session's ruleset rides along on every ask, so a tool cannot omit
        // it and a subagent's derived denials apply to everything it tries.
        const { ruleset, ...rest } = input.context
        const context: Context = {
          ...rest,
          ask: (request) => permission.ask(ruleset === undefined ? request : { ...request, ruleset }),
        }
        // Gate on the tool's own name before it runs. Previously every tool had
        // to remember to ask, and none of them did except through path-guard's
        // external_directory check — so a rule like `deny: write` was
        // unreachable and a read-only agent was read-only by convention. Doing
        // it here means a tool cannot opt out, the same reason bounding lives
        // here rather than in each tool.
        const settled = yield* context.ask({ permission: input.name, patterns: ["*"], always: ["*"] }).pipe(
          Effect.mapError((denied) => new ToolFailure({ message: denied.message })),
          Effect.flatMap(() => decode(tool, input.input)),
          Effect.flatMap((decoded) => tool.execute(decoded, context)),
          Effect.result,
        )

        if (EffectResult.isFailure(settled)) return { ok: false as const, error: settled.failure.message }

        // Bounding is applied after a successful operation, never before it, so a
        // tool that succeeded is never reported as failed because it said too much.
        const output = settled.success.output
        if (!exceeds(output)) return { ok: true as const, result: settled.success }

        // Spill first: the marker has to name the file, and writing is async
        // while bounding is not. A failed write yields undefined rather than an
        // error, because the tool already did its work.
        const path = yield* Spill.write({
          text: output,
          directory: input.context.directory,
          sessionID: input.context.sessionID,
          callID: input.context.callID,
        })
        const limited = bound(output, {
          note:
            path === undefined
              ? "The full output could not be saved, so the omitted text is lost. Narrow the request to see it."
              : `Full output saved to ${path} — use the read tool with offset and limit to see the omitted text.`,
        })
        return { ok: true as const, result: { ...settled.success, output: limited.content } }
      }).pipe(
        Effect.catchDefect((defect) =>
          Effect.succeed({
            ok: false as const,
            error: defect instanceof Error ? defect.message : String(defect),
          }),
        ),
      ),
  }
}

export const layer = (registrations: readonly Registration[]) =>
  Layer.effect(
    ToolRegistry,
    Effect.gen(function* () {
      const permission = yield* Permission
      return make(registrations, permission)
    }),
  )
