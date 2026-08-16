import { stat } from "node:fs/promises"
import path from "node:path"
import { Effect, Schema } from "effect"
import { resolveWithin } from "./path-guard"
import { make, render as renderDescription, ToolFailure, type Context } from "./tool"
import DESCRIPTION from "./glob.txt"

const DEFAULT_LIMIT = 100
export const MAX_LIMIT = 1000

/**
 * Sorting by mtime means every match must be stat'd before the limit can be
 * applied, so the walk itself needs a ceiling — otherwise `**` at a filesystem
 * root would stat forever before producing a single line of output.
 */
export const SCAN_CEILING = 10_000

/** Statting is thread-pool bound; batching keeps a big match set off one file descriptor at a time. */
const STAT_CONCURRENCY = 128

const IGNORED = ["node_modules", ".git", "dist"] as const

/**
 * A `..` segment walks out of the search root before any guard can inspect the
 * result, and Bun.Glob ignores `cwd` entirely for an absolute pattern. Both are
 * matched here — including inside a brace list, where `{..,src}/*` hides one.
 */
const ESCAPING_SEGMENT = /(^|[\\/{,])\.\.([\\/},]|$)/

const Parameters = Schema.Struct({
  pattern: Schema.String.annotate({
    description:
      'The glob pattern to match file paths against, e.g. "**/*.ts" or "src/**/config.*". Must be relative: no leading "/" and no ".." segments.',
  }),
  path: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "The directory to search in. Defaults to the session working directory; omit this field to use the default rather than passing an empty string.",
    }),
  ),
  limit: Schema.optionalKey(
    Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: MAX_LIMIT })).annotate({
      description: `Maximum number of paths to return, 1-${MAX_LIMIT}. Defaults to ${DEFAULT_LIMIT}. The most recently modified matches are kept.`,
    }),
  ),
})

type Params = typeof Parameters.Type

interface Match {
  readonly file: string
  readonly mtime: number
}

interface Scan {
  readonly matches: readonly Match[]
  /** True when the walk stopped at SCAN_CEILING, so `matches` is a floor, not a total. */
  readonly partial: boolean
  /** Matches that no longer existed by the time they were stat'd. Reported, never dropped in silence. */
  readonly vanished: number
}

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

const errorCode = (cause: unknown) => {
  if (typeof cause !== "object" || cause === null || !("code" in cause)) return undefined
  const code = (cause as { readonly code: unknown }).code
  return typeof code === "string" ? code : undefined
}

/**
 * An unreadable, looping or non-directory path is not an absent one. Reporting
 * every errno as "does not exist" sends the model looking for a typo instead of
 * fixing the actual obstacle.
 */
const STAT_FAILURES: Readonly<Record<string, string>> = {
  ENOENT: "does not exist",
  ENOTDIR: "has a component that is not a directory",
  EACCES: "cannot be read: permission denied",
  EPERM: "cannot be read: operation not permitted",
  ELOOP: "resolves through a symlink loop",
  ENAMETOOLONG: "is too long for this filesystem to resolve",
}

const statFailure = (directory: string, cause: unknown) => {
  const code = errorCode(cause)
  const reason = code === undefined ? undefined : STAT_FAILURES[code]
  if (reason !== undefined) return new ToolFailure({ message: `Search path ${directory} ${reason}.` })
  return new ToolFailure({
    message: `Search path ${directory} could not be read${code === undefined ? "" : ` (${code})`}: ${describe(cause)}`,
  })
}

/**
 * Segment equality, not substring containment. Patterns like "dist-utils/*.ts" or
 * one ending in ".gitkeep" merely mention an ignored name, and a mention must not
 * switch that ignore off for the whole walk.
 */
const namesSegment = (pattern: string, name: string) => pattern.split(/[/\\]/).includes(name)

const statAll = async (files: readonly string[], abort: AbortSignal) => {
  const found: Match[] = []
  let vanished = 0
  for (let index = 0; index < files.length; index += STAT_CONCURRENCY) {
    // The stat phase dominates a large match set, so abort is honored per batch
    // rather than only on the way in.
    if (abort.aborted) throw new Error("aborted")
    const settled = await Promise.all(
      files.slice(index, index + STAT_CONCURRENCY).map(async (file) => {
        // A match can vanish between the walk and the stat (build output, git gc).
        const info = await stat(file).catch(() => undefined)
        return info === undefined ? undefined : { file, mtime: info.mtimeMs }
      }),
    )
    for (const entry of settled) {
      if (entry === undefined) {
        vanished += 1
        continue
      }
      found.push(entry)
    }
  }
  return { found, vanished }
}

const scan = async (input: {
  readonly directory: string
  readonly pattern: string
  readonly abort: AbortSignal
}): Promise<Scan> => {
  // Only ignore a directory the caller did not ask for by name, so an explicit
  // "node_modules/**" or "dist/*.js" search still reaches its target.
  const ignored = new Set<string>(IGNORED.filter((entry) => !namesSegment(input.pattern, entry)))
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

  const statted = await statAll(files, input.abort)
  return { matches: statted.found, partial, vanished: statted.vanished }
}

const resolveDirectory = (input: Params, context: Context) =>
  Effect.gen(function* () {
    const requested = input.path ?? "."
    if (requested.trim().length === 0) {
      return yield* new ToolFailure({
        message: 'The "path" field must name a directory; omit it to search the session directory.',
      })
    }
    // Containment lives here rather than in the scan: a search root outside the
    // session directory is authorized once, up front, before anything is listed.
    const directory = yield* resolveWithin(context, requested, { kind: "directory" })
    const info = yield* Effect.tryPromise({
      try: () => stat(directory),
      catch: (cause) => statFailure(directory, cause),
    })
    if (!info.isDirectory()) {
      return yield* new ToolFailure({ message: `Search path is not a directory: ${directory}` })
    }
    return directory
  })

export const globTool = make<Params>({
  description: renderDescription(DESCRIPTION, {
    SCAN_CEILING,
    IGNORED: `${IGNORED.slice(0, -1).join(", ")}, and ${IGNORED.at(-1)}`,
  }),
  input: Parameters,
  permission: "glob",
  execute: (input, context) =>
    Effect.gen(function* () {
      if (context.abort.aborted) {
        return yield* new ToolFailure({ message: `Glob search for "${input.pattern}" was aborted before it started.` })
      }
      if (path.isAbsolute(input.pattern) || ESCAPING_SEGMENT.test(input.pattern)) {
        return yield* new ToolFailure({
          message: `Pattern "${input.pattern}" must be relative to the search directory: it may not start at the filesystem root or contain a ".." segment. Put the directory in "path" and keep the pattern relative, e.g. path="/etc" with pattern="*.conf".`,
        })
      }

      const directory = yield* resolveDirectory(input, context)
      const limit = input.limit ?? DEFAULT_LIMIT

      const result = yield* Effect.tryPromise({
        try: () => scan({ directory, pattern: input.pattern, abort: context.abort }),
        catch: (cause) =>
          context.abort.aborted
            ? new ToolFailure({ message: `Glob search for "${input.pattern}" was aborted before it finished.` })
            : new ToolFailure({
                message: `Glob search failed for pattern "${input.pattern}" in ${directory}: ${describe(cause)}`,
              }),
      })

      const ordered = result.matches.toSorted((left, right) => right.mtime - left.mtime)
      const shown = ordered.slice(0, limit)
      const truncated = ordered.length > limit
      const relative = path.relative(context.directory, directory)
      const title = relative === "" ? input.pattern : `${input.pattern} in ${relative}`
      const metadata = {
        count: shown.length,
        matched: ordered.length,
        truncated,
        partialScan: result.partial,
        vanished: result.vanished,
        directory,
      }

      const notes: string[] = []
      if (result.partial) {
        notes.push(
          `(Showing ${shown.length} of the first ${ordered.length} matches. The walk stopped at the ${SCAN_CEILING}-match ceiling in directory order, so this is an arbitrary sample of a larger set, not the newest files overall. Narrow the pattern or the path.)`,
        )
      }
      if (!result.partial && truncated) {
        notes.push(
          `(Showing the ${shown.length} most recently modified of ${ordered.length} matches. Use a more specific pattern or path.)`,
        )
      }
      if (result.vanished > 0) {
        notes.push(
          `(${result.vanished} matched ${result.vanished === 1 ? "path" : "paths"} disappeared before they could be read and ${result.vanished === 1 ? "is" : "are"} not listed.)`,
        )
      }

      if (shown.length === 0) {
        return {
          title,
          output: [`No files matched "${input.pattern}" under ${directory}`, ...notes].join("\n\n"),
          metadata,
        }
      }

      return {
        title,
        output: [shown.map((entry) => entry.file).join("\n"), ...notes].join("\n\n"),
        metadata,
      }
    }),
})
