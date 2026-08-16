import { stat } from "node:fs/promises"
import path from "node:path"
import { Effect, Schema } from "effect"
import { make, ToolFailure, type Context } from "./tool"

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 1000

/**
 * Sorting by mtime means every match must be stat'd before the limit can be
 * applied, so the walk itself needs a ceiling — otherwise `**` at a filesystem
 * root would stat forever before producing a single line of output.
 */
const SCAN_CEILING = 10_000

/** Statting is thread-pool bound; batching keeps a big match set off one file descriptor at a time. */
const STAT_CONCURRENCY = 128

const IGNORED = ["node_modules", ".git", "dist"] as const

const DESCRIPTION = `Fast file-path search by glob pattern. Reach for this whenever you know something about a file's name or location but not its contents.

- Supports standard glob syntax: "**/*.ts", "src/**/__tests__/*.spec.ts", "*.{json,yaml}", "?" for a single character.
- Matches paths only, never file contents. To search inside files, use grep instead.
- Returns absolute paths sorted by modification time, most recently edited first. In an active repository the top handful of results are usually the files the current task is about, so read them in the order given.
- "path" defaults to the session's working directory. Omit the field to use that default; do not pass the strings "undefined" or "null". A relative path is resolved against the session directory.
- Directories named node_modules, .git, and dist are skipped, unless your pattern names one of them explicitly (so "node_modules/**/package.json" still works).
- At most "limit" paths are returned (default ${DEFAULT_LIMIT}). If more files matched, the output says how many — prefer narrowing the pattern or the path over raising the limit.
- No matches is a normal result, not an error. If a pattern comes back empty, try a broader one before concluding the file does not exist.
- Calls are cheap: issue several speculative patterns in one turn rather than guessing a single pattern and waiting.
- For open-ended exploration that will need many rounds of globbing and grepping, delegate to a subagent instead of driving it yourself.`

const Parameters = Schema.Struct({
  pattern: Schema.String.annotations({
    description: 'The glob pattern to match file paths against, e.g. "**/*.ts" or "src/**/config.*"',
  }),
  path: Schema.optional(
    Schema.String.annotations({
      description:
        "The directory to search in. Defaults to the session working directory; omit this field to use the default rather than passing an empty string.",
    }),
  ),
  limit: Schema.optional(
    Schema.Number.pipe(Schema.int(), Schema.between(1, MAX_LIMIT)).annotations({
      description: `Maximum number of paths to return, 1-${MAX_LIMIT}. Defaults to ${DEFAULT_LIMIT}. The most recently modified matches are kept.`,
    }),
  ),
})

interface Match {
  readonly file: string
  readonly mtime: number
}

interface Scan {
  readonly matches: readonly Match[]
  /** True when the walk stopped at SCAN_CEILING, so `matches` is a floor, not a total. */
  readonly partial: boolean
}

const statAll = async (files: readonly string[]): Promise<readonly Match[]> => {
  const found: Match[] = []
  for (let i = 0; i < files.length; i += STAT_CONCURRENCY) {
    const settled = await Promise.all(
      files.slice(i, i + STAT_CONCURRENCY).map(async (file) => {
        // A match can vanish between the walk and the stat (build output, git gc).
        const info = await stat(file).catch(() => undefined)
        return info === undefined ? undefined : { file, mtime: info.mtimeMs }
      }),
    )
    found.push(...settled.filter((entry): entry is Match => entry !== undefined))
  }
  return found
}

const scan = async (input: {
  readonly directory: string
  readonly pattern: string
  readonly abort: AbortSignal
}): Promise<Scan> => {
  // Only ignore a directory the caller did not ask for by name, so an explicit
  // "node_modules/**" or "dist/*.js" search still reaches its target.
  const ignored = new Set<string>(IGNORED.filter((entry) => !input.pattern.includes(entry)))
  const glob = new Bun.Glob(input.pattern)
  const files: string[] = []
  let partial = false

  for await (const relative of glob.scan({
    cwd: input.directory,
    dot: true,
    onlyFiles: true,
    followSymlinks: false,
  })) {
    if (input.abort.aborted) throw new Error("aborted")
    const segments = relative.split(/[/\\]/).slice(0, -1)
    if (segments.some((segment) => ignored.has(segment))) continue
    if (files.length >= SCAN_CEILING) {
      partial = true
      break
    }
    files.push(path.resolve(input.directory, relative))
  }

  return { matches: await statAll(files), partial }
}

const resolveDirectory = (input: { readonly path?: string | undefined }, context: Context) =>
  Effect.gen(function* () {
    const requested = input.path ?? context.directory
    const directory = path.isAbsolute(requested) ? requested : path.resolve(context.directory, requested)
    const info = yield* Effect.tryPromise({
      try: () => stat(directory),
      catch: () => new ToolFailure({ message: `Search path does not exist: ${directory}` }),
    })
    if (!info.isDirectory()) {
      return yield* new ToolFailure({ message: `Search path is not a directory: ${directory}` })
    }
    return directory
  })

export const globTool = make({
  description: DESCRIPTION,
  input: Parameters,
  permission: "glob",
  execute: (input, context) =>
    Effect.gen(function* () {
      const directory = yield* resolveDirectory(input, context)
      const limit = input.limit ?? DEFAULT_LIMIT

      const result = yield* Effect.tryPromise({
        try: () => scan({ directory, pattern: input.pattern, abort: context.abort }),
        catch: (cause) =>
          new ToolFailure({
            message: `Glob search failed for pattern "${input.pattern}" in ${directory}: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          }),
      })

      const ordered = result.matches.slice().sort((left, right) => right.mtime - left.mtime)
      const shown = ordered.slice(0, limit)
      const truncated = ordered.length > limit
      const relative = path.relative(context.directory, directory)
      const title = relative === "" ? input.pattern : `${input.pattern} in ${relative}`
      const metadata = {
        count: shown.length,
        matched: ordered.length,
        truncated,
        partialScan: result.partial,
        directory,
      }

      if (shown.length === 0) {
        return {
          title,
          output: `No files matched "${input.pattern}" under ${directory}`,
          metadata,
        }
      }

      const total = result.partial ? `${ordered.length}+` : `${ordered.length}`
      const notice = truncated
        ? `\n\n(Showing the ${shown.length} most recently modified of ${total} matches. Use a more specific pattern or path.)`
        : ""

      return {
        title,
        output: shown.map((entry) => entry.file).join("\n") + notice,
        metadata,
      }
    }),
})
