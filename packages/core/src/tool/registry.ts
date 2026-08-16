import { Context as EffectContext, Effect, Layer, Result as EffectResult } from "effect"
import { Permission, type Interface as PermissionService } from "../permission/permission"
import { Spill } from "./spill"
import { bound, exceeds } from "./truncate"
import { decode, validName, type Context, type Result, type Tool } from "./tool"

/**
 * What a caller supplies. `ask` is injected by the registry from the Permission
 * service, so the runner never touches policy and no tool can bypass it.
 */
export type CallContext = Omit<Context, "ask">

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

        const context: Context = { ...input.context, ask: permission.ask }
        const settled = yield* decode(tool, input.input).pipe(
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
