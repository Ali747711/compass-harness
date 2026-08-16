// Adapted from opencode (MIT). Source: packages/opencode/src/tool/read.ts
// https://github.com/anomalyco/opencode — see licenses/opencode-MIT.txt
//
// Diverges from the original: no directory listing, no image/PDF attachments
// (this harness has no attachment channel yet, so those refuse instead), and
// `offset` is a 0-based line index rather than 1-indexed.

import { Effect, Result, Schema } from "effect"
import { readdir, stat } from "node:fs/promises"
import { basename, dirname, extname, isAbsolute, join, relative } from "node:path"
import { resolveWithin } from "./path-guard"
import { ToolFailure, make, type Context } from "./tool"

const DEFAULT_LIMIT = 2000
const MAX_LINE_WIDTH = 2000
const LINE_CUT = `... (line truncated at ${MAX_LINE_WIDTH} characters)`
const SAMPLE_BYTES = 4096
const SUGGESTION_LIMIT = 3
/** Names shorter than this carry too little signal to suggest anything from. */
const MIN_SUGGESTION_LENGTH = 3
/** Normalized edit distance a name must clear before it is offered as a near-miss. */
const SIMILARITY_THRESHOLD = 0.6
// Above this share of control bytes in the sample, the file is not text worth showing.
const NON_PRINTABLE_RATIO = 0.3

const DESCRIPTION = `Reads a file from the local filesystem and returns its contents as numbered lines.

Usage:
- filePath may be absolute, or relative to the session's working directory.
- Returns up to ${DEFAULT_LIMIT} lines starting at offset. Pass limit to ask for fewer.
- offset is a 0-based line index: offset 0 starts at the first line, offset 100 starts at line 101. The numbers in the output are always the real 1-based line numbers in the file, so they stay stable no matter which window you request.
- Each line comes back as \`<line number>: <content>\`. A file containing "foo\\n" is returned as "1: foo".
- The last line of the output states either that you reached the end of the file, or the exact offset to pass to continue reading.
- Lines longer than ${MAX_LINE_WIDTH} characters are cut short and marked. Use grep to search minified or generated files instead of reading them.
- Prefer one wide window over many narrow ones. Re-reading the same file in 30-line slices wastes turns; if you need more context, raise limit.
- Call this tool in parallel when you already know several files you want to read.
- Read a file before editing it. Editing contents you have not seen is a guess.
- Text only. Directories, images, PDFs, archives, and other binary files are refused.
- A path outside the session's working directory needs permission first.
- A path that does not exist is an error, and names similar files in the same directory when it can. Use glob when you are unsure of a path.`

const Input = Schema.Struct({
  filePath: Schema.String.annotate({
    description: "Path to the file to read. Absolute, or relative to the session's working directory.",
  }),
  offset: Schema.optionalKey(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))).annotate({
    description: "0-based line index to start reading from. Line 1 of the file is offset 0. Defaults to 0.",
  }),
  limit: Schema.optionalKey(Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))).annotate({
    description: `Maximum number of lines to return. Defaults to ${DEFAULT_LIMIT}.`,
  }),
})

type Input = typeof Input.Type

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".ico",
  ".tif",
  ".tiff",
  ".avif",
  ".heic",
])

const BINARY_EXTENSIONS = new Set([
  ".7z",
  ".a",
  ".bin",
  ".class",
  ".dat",
  ".dll",
  ".doc",
  ".docx",
  ".dylib",
  ".exe",
  ".gz",
  ".jar",
  ".lib",
  ".mp3",
  ".mp4",
  ".o",
  ".obj",
  ".odp",
  ".ods",
  ".odt",
  ".pdf",
  ".ppt",
  ".pptx",
  ".pyc",
  ".pyo",
  ".so",
  ".tar",
  ".wasm",
  ".woff",
  ".woff2",
  ".xls",
  ".xlsx",
  ".zip",
])

const reason = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

const errnoCode = (cause: unknown) => {
  if (typeof cause !== "object" || cause === null) return undefined
  const code = (cause as { readonly code?: unknown }).code
  return typeof code === "string" ? code : undefined
}

const cancelled = (filePath: string) => new ToolFailure({ message: `Read of ${filePath} was cancelled.` })

/**
 * Cancellation is re-checked between awaits rather than once at entry: a read
 * that is abandoned mid-stream should stop at the next boundary, not finish.
 */
const checkpoint = (context: Context, filePath: string) =>
  Effect.suspend(() => (context.abort.aborted ? Effect.fail(cancelled(filePath)) : Effect.void))

/** Short label for the TUI: relative to the session directory when the file lives under it. */
const label = (filePath: string, directory: string) => {
  const rel = relative(directory, filePath)
  return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? filePath : rel
}

const looksBinary = (bytes: Uint8Array) => {
  if (bytes.length === 0) return false
  let nonPrintable = 0
  for (const byte of bytes) {
    if (byte === 0) return true
    if (byte < 9 || (byte > 13 && byte < 32)) nonPrintable += 1
  }
  return nonPrintable / bytes.length > NON_PRINTABLE_RATIO
}

const stem = (name: string) => {
  const extension = extname(name)
  return (extension === "" ? name : name.slice(0, -extension.length)).toLowerCase()
}

/** Levenshtein distance over code points. Filenames are short, so the full row scan is cheap. */
const distance = (left: string, right: string) => {
  const a = Array.from(left)
  const b = Array.from(right)
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1)
      const deletion = (previous[j] ?? 0) + 1
      const insertion = (current[j - 1] ?? 0) + 1
      current.push(Math.min(substitution, deletion, insertion))
    }
    previous = current
  }
  return previous[b.length] ?? 0
}

/** 1 for identical, 0 for nothing in common. Containment scores as the length ratio. */
const ratio = (left: string, right: string) => {
  const longest = Math.max(Array.from(left).length, Array.from(right).length)
  if (longest === 0) return 0
  return 1 - distance(left, right) / longest
}

/**
 * Whole-name distance under-scores near-misses that differ only in extension
 * (`read.txt` for `read.ts`), so stems are scored too and the better one wins.
 * Stems below the floor are ignored: a one-letter stem like `a.go` matches
 * everything and would otherwise turn "did you mean" into a directory listing.
 */
const similarity = (base: string, entry: string) => {
  const whole = ratio(base.toLowerCase(), entry.toLowerCase())
  const left = stem(base)
  const right = stem(entry)
  if (left.length < MIN_SUGGESTION_LENGTH || right.length < MIN_SUGGESTION_LENGTH) return whole
  return Math.max(whole, ratio(left, right))
}

const missing = (context: Context, filePath: string) =>
  Effect.gen(function* () {
    const directory = dirname(filePath)
    const base = basename(filePath)
    const plain = new ToolFailure({ message: `File not found: ${filePath}` })
    if (base.length < MIN_SUGGESTION_LENGTH) return yield* plain

    // An unreadable or missing parent directory just means no suggestions to offer.
    const entries = yield* Effect.promise(() => readdir(directory).catch((): readonly string[] => []))
    yield* checkpoint(context, filePath)

    const ranked = entries
      .filter((entry) => entry.length >= MIN_SUGGESTION_LENGTH)
      .map((entry) => ({ entry, score: similarity(base, entry) }))
      .filter((candidate) => candidate.score >= SIMILARITY_THRESHOLD)
      // Closest score first, then closest in length, then alphabetical, so ranking is stable.
      .toSorted(
        (a, b) =>
          b.score - a.score ||
          Math.abs(a.entry.length - base.length) - Math.abs(b.entry.length - base.length) ||
          a.entry.localeCompare(b.entry),
      )

    if (ranked.length === 0) return yield* plain

    const shown = ranked.slice(0, SUGGESTION_LIMIT)
    const omitted = ranked.length - shown.length
    // Capping is stated rather than silent, so the absence of a name is never mistaken for its absence on disk.
    const note = omitted === 0 ? "" : `\n(${omitted} further similar name${omitted === 1 ? "" : "s"} not shown.)`
    return yield* new ToolFailure({
      message: `File not found: ${filePath}\n\nDid you mean one of these?\n${shown
        .map((candidate) => join(directory, candidate.entry))
        .join("\n")}${note}`,
    })
  })

interface Page {
  readonly lines: readonly string[]
  readonly total: number
}

/**
 * Cuts by code point, not UTF-16 unit: slicing mid-surrogate-pair emits a lone
 * surrogate that survives all the way into the model's context as a replacement
 * character.
 */
const clip = (line: string) => {
  // A UTF-16 length within budget guarantees the code point count is too.
  if (line.length <= MAX_LINE_WIDTH) return line
  const points = Array.from(line)
  if (points.length <= MAX_LINE_WIDTH) return line
  return `${points.slice(0, MAX_LINE_WIDTH).join("")}${LINE_CUT}`
}

/**
 * Streams the file so a huge one costs I/O but not memory. The whole file is
 * walked even after `limit` is reached, because an accurate total line count is
 * what makes the continuation offset in the footer trustworthy.
 */
const paginate = (filePath: string, offset: number, limit: number, abort: AbortSignal) =>
  Effect.tryPromise({
    try: async () => {
      const lines: string[] = []
      let total = 0
      let pending = ""

      const take = (raw: string) => {
        total += 1
        if (total <= offset || lines.length >= limit) return
        const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw
        lines.push(clip(line))
      }

      const decoder = new TextDecoder()
      for await (const chunk of Bun.file(filePath).stream()) {
        if (abort.aborted) throw new Error("read cancelled")
        const parts = (pending + decoder.decode(chunk, { stream: true })).split("\n")
        pending = parts.pop() ?? ""
        for (const part of parts) take(part)
      }

      pending += decoder.decode()
      // A trailing newline closes the final line; only a non-empty remainder is one.
      if (pending.length > 0) take(pending)

      return { lines, total } satisfies Page
    },
    catch: (cause) =>
      abort.aborted
        ? cancelled(filePath)
        : new ToolFailure({ message: `Could not read ${filePath}: ${reason(cause)}` }),
  })

const render = (filePath: string, body: string, footer: string) =>
  [`<path>${filePath}</path>`, "<content>", body, "</content>", "", footer].join("\n")

export const readTool = make<Input>({
  description: DESCRIPTION,
  input: Input,
  execute: (input, context) =>
    Effect.gen(function* () {
      const filePath = yield* resolveWithin(context, input.filePath)
      const title = label(filePath, context.directory)
      yield* checkpoint(context, filePath)

      const stats = yield* Effect.tryPromise({ try: () => stat(filePath), catch: errnoCode }).pipe(Effect.result)
      yield* checkpoint(context, filePath)
      if (Result.isFailure(stats)) {
        // ENOTDIR means a parent component is a file, e.g. reading `notes.txt/inner`.
        if (stats.failure === "ENOENT" || stats.failure === "ENOTDIR") return yield* missing(context, filePath)
        return yield* new ToolFailure({
          message: `Cannot access ${filePath}${stats.failure === undefined ? "" : ` (${stats.failure})`}.`,
        })
      }

      const info = stats.success
      if (info.isDirectory()) {
        return yield* new ToolFailure({
          message: `${filePath} is a directory, not a file. Read one of the files inside it, or use glob to list its contents.`,
        })
      }
      if (!info.isFile()) {
        return yield* new ToolFailure({ message: `${filePath} is not a regular file and cannot be read.` })
      }

      // Format guards come before the empty-file shortcut: a zero-byte .png is still
      // a .png, and reporting it as an empty text file invites the model to trust it.
      const extension = extname(filePath).toLowerCase()
      if (IMAGE_EXTENSIONS.has(extension)) {
        return yield* new ToolFailure({
          message: `Cannot read ${filePath}: ${extension} is an image and this tool returns text only.`,
        })
      }
      if (BINARY_EXTENSIONS.has(extension)) {
        return yield* new ToolFailure({
          message: `Cannot read ${filePath}: ${extension} is a binary format and this tool returns text only.`,
        })
      }

      if (info.size === 0) {
        return {
          title,
          output: render(filePath, "", "(File is empty - 0 lines)"),
          metadata: { path: filePath, totalLines: 0, empty: true },
        }
      }

      const sample = yield* Effect.tryPromise({
        try: () => Bun.file(filePath).slice(0, SAMPLE_BYTES).bytes(),
        catch: (cause) => new ToolFailure({ message: `Could not read ${filePath}: ${reason(cause)}` }),
      })
      yield* checkpoint(context, filePath)
      if (looksBinary(sample)) {
        return yield* new ToolFailure({
          message: `Cannot read ${filePath}: it contains binary data, not text. Use a shell command if you need to inspect it.`,
        })
      }

      const offset = input.offset ?? 0
      const limit = input.limit ?? DEFAULT_LIMIT
      const page = yield* paginate(filePath, offset, limit, context.abort)

      if (offset >= page.total) {
        return yield* new ToolFailure({
          message: `Offset ${offset} is past the end of ${filePath}: the file has ${page.total} line${page.total === 1 ? "" : "s"}, so the last valid offset is ${page.total - 1}.`,
        })
      }

      const first = offset + 1
      const last = offset + page.lines.length
      const body = page.lines.map((line, index) => `${first + index}: ${line}`).join("\n")
      const more = last < page.total
      const footer = more
        ? `(Showing lines ${first}-${last} of ${page.total}. Use offset=${last} to continue.)`
        : `(End of file - ${page.total} lines)`

      return {
        title,
        output: render(filePath, body, footer),
        // Deliberately no delivered line range. The registry bounds `output` after
        // this returns, so any exact range stated here could contradict what the
        // model actually received; the footer inside `output` is the one claim
        // about the window, and it travels with the text it describes.
        metadata: { path: filePath, totalLines: page.total, requestedOffset: offset, requestedLimit: limit, more },
      }
    }),
})
