import { Context as EffectContext, Effect, Layer } from "effect"
import { bound } from "./truncate"
import { decode, validName, type Context, type Result, type Tool } from "./tool"

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
    readonly context: Context
  }) => Effect.Effect<Settlement>
}

export class ToolRegistry extends EffectContext.Tag("compass/ToolRegistry")<ToolRegistry, Interface>() {}

export function make(registrations: readonly Registration[]): Interface {
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

        const settled = yield* decode(tool, input.input).pipe(
          Effect.flatMap((decoded) => tool.execute(decoded, input.context)),
          Effect.either,
        )

        if (settled._tag === "Left") return { ok: false as const, error: settled.left.message }

        // Bounding is applied after a successful operation, never before it, so a
        // tool that succeeded is never reported as failed because it said too much.
        const limited = bound(settled.right.output)
        return {
          ok: true as const,
          result: limited.truncated ? { ...settled.right, output: limited.content } : settled.right,
        }
      }).pipe(
        Effect.catchAllDefect((defect) =>
          Effect.succeed({
            ok: false as const,
            error: defect instanceof Error ? defect.message : String(defect),
          }),
        ),
      ),
  }
}

export const layer = (registrations: readonly Registration[]) => Layer.sync(ToolRegistry, () => make(registrations))
