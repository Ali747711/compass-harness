import { Effect } from "effect"
import { realpathSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { ToolFailure, type Context } from "./tool"

/**
 * True when `target` is `directory` itself or lives beneath it.
 *
 * Mirrors opencode's `containsPath`, with one deliberate difference: symlinks are
 * resolved first. opencode compares lexical paths, so a symlink inside the project
 * pointing outside it reads as contained. That is a real escape, and resolving it
 * costs nothing here because the guard already touches the filesystem.
 */
export function contains(directory: string, target: string) {
  const root = realOrLexical(directory)
  const full = realOrLexical(target)
  if (root === full) return true
  const rel = relative(root, full)
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)
}

/**
 * Resolves the deepest existing ancestor, so a path whose leaf does not exist yet
 * (the common case for `write`) is still checked against its real parent.
 */
function realOrLexical(target: string): string {
  const absolute = resolve(target)
  let current = absolute
  const trailing: string[] = []
  for (;;) {
    try {
      return join(realpathSync(current), ...trailing)
    } catch {
      const parent = dirname(current)
      if (parent === current) return absolute
      trailing.unshift(current.slice(parent.length + 1))
      current = parent
    }
  }
}

export interface GuardOptions {
  /** "directory" treats the target itself as the directory to authorize. */
  readonly kind?: "file" | "directory"
}

/**
 * Resolves `target` against the session directory and, when it lands outside,
 * asks for the `external_directory` permission before allowing the tool to
 * proceed. Returns the resolved absolute path.
 *
 * This is a guardrail, not a sandbox — `bash` grants full system access anyway.
 * Its job is to make an out-of-project write a deliberate choice.
 */
export const resolveWithin = (context: Context, target: string, options: GuardOptions = {}) =>
  Effect.gen(function* () {
    if (target.trim().length === 0) {
      return yield* new ToolFailure({ message: "filePath must not be empty." })
    }
    const full = resolve(context.directory, target)
    if (contains(context.directory, full)) return full

    const dir = (options.kind ?? "file") === "directory" ? full : dirname(full)
    yield* context
      .ask({
        permission: "external_directory",
        patterns: [join(dir, "*")],
        always: [join(dir, "*")],
        metadata: { filePath: full, parentDir: dir },
      })
      .pipe(
        Effect.mapError(
          () =>
            new ToolFailure({
              message: `${full} is outside the session directory (${context.directory}) and access was not granted.`,
            }),
        ),
      )
    return full
  })

/**
 * How a path is shown to the model.
 *
 * Relative to the session directory when it is inside it, absolute otherwise.
 * Two reasons. Every absolute path repeats a prefix the model already knows —
 * roughly 45 characters per line here, which is real context spent on nothing
 * at a hundred results. And a path that stays absolute is then a signal rather
 * than noise: it means this file is outside the project.
 */
export function displayPath(directory: string, target: string) {
  if (!contains(directory, target)) return target
  // `contains` compares real paths, `relative` is lexical, and the two disagree
  // whenever a symlink sits between them (/var → /private/var on macOS). When
  // they do, the "relative" path climbs out with `..` — longer and less clear
  // than what it replaced — so keep the absolute form instead.
  const rel = relative(directory, target)
  if (rel === "") return "."
  return rel.startsWith("..") || isAbsolute(rel) ? target : rel
}
