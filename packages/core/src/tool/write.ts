import { Effect, Schema } from "effect"
import { mkdir, stat } from "node:fs/promises"
import * as path from "node:path"
import { contains, resolveWithin } from "./path-guard"
import { make, ToolFailure, type Context } from "./tool"

const DESCRIPTION = `Writes a file to the local filesystem, creating any missing parent directories.

Usage:
- \`filePath\` may be absolute, or relative to the session's working directory. Prefer absolute paths.
- Provide the complete final contents of the file. There is no append mode, no merge, and no placeholder
  expansion: whatever you pass becomes the entire file.
- If a file already exists at the path it is overwritten in full. Read it first so you know exactly what you
  are replacing, and prefer the edit tool when you only need to change part of an existing file.
- Missing parent directories are created for you, so you never need a separate command to make them.
- A path that resolves outside the session directory — including one reached through a symlink — needs
  explicit approval first, and the write fails if approval is refused.
- Fails if the path names an existing directory, or if a component of the path is a file.
- ALWAYS prefer editing an existing file over creating a new one. Only create files the task actually needs.
- NEVER proactively create documentation files (*.md) or README files. Write documentation only when the user
  explicitly asks for it.
- Only include emojis if the user explicitly asks for them.

The result reports whether the file was created or overwritten, along with its size, so you can confirm the
write landed without reading the file back.`

const Input = Schema.Struct({
  filePath: Schema.String.annotate({
    description: "Path of the file to write. Absolute is preferred; relative resolves against the session directory.",
  }),
  content: Schema.String.annotate({
    description: "The complete contents to write. Replaces the whole file when one already exists.",
  }),
})

type Input = typeof Input.Type

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error))

const codeOf = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined

// ENOENT and ENOTDIR both mean "nothing is there" — a missing leaf, or a leaf under a
// path component that is a file. Every other stat error (EACCES, ELOOP, ENAMETOOLONG)
// means we do not know what is there, and reporting a write as "Created" on that basis
// would be a lie the caller cannot detect.
const ABSENT = new Set(["ENOENT", "ENOTDIR"])

const inspect = (target: string) =>
  Effect.tryPromise({
    try: () => stat(target),
    catch: (error) => error,
  }).pipe(
    Effect.catch((error) =>
      ABSENT.has(codeOf(error) ?? "")
        ? Effect.succeed(undefined)
        : Effect.fail(
            new ToolFailure({
              message: `Could not inspect ${target}: ${reason(error)}. Nothing was written.`,
            }),
          ),
    ),
  )

/** The turn can be cancelled during any await, so every await is followed by another look. */
const abortIf = (context: Context, when: string): Effect.Effect<void, ToolFailure> =>
  Effect.suspend(() =>
    context.abort.aborted ? Effect.fail(new ToolFailure({ message: `Write aborted ${when}.` })) : Effect.void,
  )

const countLines = (content: string) => {
  if (content === "") return 0
  const newlines = content.split("\n").length - 1
  return content.endsWith("\n") ? newlines : newlines + 1
}

const plural = (count: number, unit: string) => `${count} ${unit}${count === 1 ? "" : "s"}`

const describe = (bytes: number, lines: number) => `${plural(lines, "line")}, ${plural(bytes, "byte")}`

export const writeTool = make({
  description: DESCRIPTION,
  input: Input,
  // Shared with the edit tool: approving edits to a path should not require a second
  // approval to overwrite it wholesale.
  permission: "edit",
  execute: (input: Input, context: Context) =>
    Effect.gen(function* () {
      yield* abortIf(context, "before it started")

      // Rejects a blank path, and resolves symlinks before deciding containment, so a
      // link inside the session directory that points out of it still needs approval.
      const filePath = yield* resolveWithin(context, input.filePath)
      const escapes = !contains(context.directory, filePath)
      const display = escapes ? filePath : path.relative(context.directory, filePath) || filePath

      const existing = yield* inspect(filePath)
      if (existing?.isDirectory())
        return yield* new ToolFailure({
          message: `${filePath} is a directory, not a file. Choose a file path inside it, or remove the directory first.`,
        })

      yield* abortIf(context, "before its parent directory was created")

      const parent = path.dirname(filePath)
      const createdDir = yield* Effect.tryPromise({
        try: () => mkdir(parent, { recursive: true }),
        catch: (error) =>
          new ToolFailure({ message: `Could not create the parent directory ${parent}: ${reason(error)}` }),
      })

      yield* abortIf(context, "before its contents were written")

      const bytes = yield* Effect.tryPromise({
        try: () => Bun.write(filePath, input.content),
        catch: (error) => new ToolFailure({ message: `Could not write ${filePath}: ${reason(error)}` }),
      })

      const lines = countLines(input.content)
      const replaced = existing !== undefined
      const summary = replaced
        ? `Overwrote ${display} (${describe(bytes, lines)}; previous size ${plural(existing.size, "byte")}).`
        : `Created ${display} (${describe(bytes, lines)}).`

      // Both notes describe something the caller did not ask for and could not otherwise
      // see: a directory that now exists, and a write that landed out of the project.
      const notes = [
        ...(createdDir === undefined ? [] : [`Created parent directory ${createdDir}.`]),
        ...(escapes ? [`This path resolves outside the session directory ${context.directory}.`] : []),
      ]

      return {
        title: display,
        output: [summary, ...notes].join("\n"),
        metadata: { filePath, existed: replaced, bytes, lines, createdDirectory: createdDir, outside: escapes },
      }
    }),
})
