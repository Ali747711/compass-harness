import { Effect, Schema } from "effect"
import { mkdir, stat } from "node:fs/promises"
import * as path from "node:path"
import { make, ToolFailure, type Context } from "./tool"

const DESCRIPTION = `Writes a file to the local filesystem, creating any missing parent directories.

Usage:
- \`filePath\` may be absolute, or relative to the session's working directory. Prefer absolute paths.
- Provide the complete final contents of the file. There is no append mode, no merge, and no placeholder
  expansion: whatever you pass becomes the entire file.
- If a file already exists at the path it is overwritten in full. Read it first so you know exactly what you
  are replacing, and prefer the edit tool when you only need to change part of an existing file.
- Missing parent directories are created for you, so you never need a separate command to make them.
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

/** Reports "absent" instead of failing: the write itself surfaces real IO errors with a better message. */
const inspect = (target: string) =>
  Effect.promise(() =>
    stat(target).then(
      (info) => info,
      () => undefined,
    ),
  )

const countLines = (content: string) => {
  if (content === "") return 0
  const newlines = content.split("\n").length - 1
  return content.endsWith("\n") ? newlines : newlines + 1
}

const describe = (bytes: number, lines: number) => `${lines} line${lines === 1 ? "" : "s"}, ${bytes} bytes`

export const writeTool = make({
  description: DESCRIPTION,
  input: Input,
  // Shared with the edit tool: approving edits to a path should not require a second
  // approval to overwrite it wholesale.
  permission: "edit",
  execute: (input: Input, context: Context) =>
    Effect.gen(function* () {
      if (context.abort.aborted) return yield* new ToolFailure({ message: "Write aborted before it started." })

      const filepath = path.resolve(context.directory, input.filePath)
      const display = path.relative(context.directory, filepath) || filepath

      const existing = yield* inspect(filepath)
      if (existing?.isDirectory())
        return yield* new ToolFailure({
          message: `${filepath} is a directory, not a file. Choose a file path inside it, or remove the directory first.`,
        })

      const parent = path.dirname(filepath)
      const createdDir = yield* Effect.tryPromise({
        try: () => mkdir(parent, { recursive: true }),
        catch: (error) =>
          new ToolFailure({ message: `Could not create the parent directory ${parent}: ${reason(error)}` }),
      })

      const bytes = yield* Effect.tryPromise({
        try: () => Bun.write(filepath, input.content),
        catch: (error) => new ToolFailure({ message: `Could not write ${filepath}: ${reason(error)}` }),
      })

      const lines = countLines(input.content)
      const replaced = existing !== undefined
      const summary = replaced
        ? `Overwrote ${display} (${describe(bytes, lines)}; previous size ${existing.size} bytes).`
        : `Created ${display} (${describe(bytes, lines)}).`

      return {
        title: display,
        output: createdDir === undefined ? summary : `${summary}\nCreated parent directory ${createdDir}.`,
        metadata: { filepath, existed: replaced, bytes, lines, createdDirectory: createdDir },
      }
    }),
})
