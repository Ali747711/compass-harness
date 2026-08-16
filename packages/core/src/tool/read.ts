// Adapted from opencode (MIT). Source: packages/opencode/src/tool/read.ts
// https://github.com/anomalyco/opencode — see licenses/opencode-MIT.txt
//
// Diverges from the original: no directory listing, no image/PDF attachments
// (this harness has no attachment channel yet, so those refuse instead), and
// `offset` is a 0-based line index rather than 1-indexed.

import { Effect, Either, Schema } from "effect"
import { readdir, stat } from "node:fs/promises"
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path"
import { ToolFailure, make } from "./tool"

const DEFAULT_LIMIT = 2000
const MAX_LINE_WIDTH = 2000
const LINE_CUT = `... (line truncated at ${MAX_LINE_WIDTH} characters)`
const SAMPLE_BYTES = 4096
const SUGGESTION_LIMIT = 3
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
- A path that does not exist is an error, and names similar files in the same directory when it can. Use glob when you are unsure of a path.`

const Input = Schema.Struct({
  filePath: Schema.String.annotations({
    description: "Path to the file to read. Absolute, or relative to the session's working directory.",
  }),
  offset: Schema.optional(
    Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)).annotations({ title: "offset" }),
  ).annotations({
    description: "0-based line index to start reading from. Line 1 of the file is offset 0. Defaults to 0.",
  }),
  limit: Schema.optional(
    Schema.Number.pipe(Schema.int(), Schema.positive()).annotations({ title: "limit" }),
  ).annotations({ description: `Maximum number of lines to return. Defaults to ${DEFAULT_LIMIT}.` }),
})

type Input = Schema.Schema.Type<typeof Input>

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

/**
 * Whole-name containment misses the common near-misses (`config.json` for
 * `configuration.json`, `read.txt` for `read.ts`), so stems are compared too.
 */
const similar = (base: string, entry: string) => {
  const a = base.toLowerCase()
  const b = entry.toLowerCase()
  if (a.includes(b) || b.includes(a)) return true
  const left = stem(base)
  const right = stem(entry)
  return left !== "" && right !== "" && (left.includes(right) || right.includes(left))
}

const missing = (filePath: string) =>
  Effect.gen(function* () {
    const directory = dirname(filePath)
    const base = basename(filePath)
    // An unreadable or missing parent directory just means no suggestions to offer.
    const entries = yield* Effect.promise(() => readdir(directory).catch((): readonly string[] => []))
    const candidates = entries
      .filter((entry) => similar(base, entry))
      // Closest in length first, then alphabetical, so suggestions are ranked and stable.
      .toSorted((a, b) => Math.abs(a.length - base.length) - Math.abs(b.length - base.length) || a.localeCompare(b))
      .slice(0, SUGGESTION_LIMIT)
      .map((entry) => join(directory, entry))

    if (candidates.length === 0) return yield* new ToolFailure({ message: `File not found: ${filePath}` })
    return yield* new ToolFailure({
      message: `File not found: ${filePath}\n\nDid you mean one of these?\n${candidates.join("\n")}`,
    })
  })

interface Page {
  readonly lines: readonly string[]
  readonly total: number
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
        lines.push(line.length > MAX_LINE_WIDTH ? `${line.slice(0, MAX_LINE_WIDTH)}${LINE_CUT}` : line)
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
      new ToolFailure({
        message: abort.aborted ? `Read of ${filePath} was cancelled.` : `Could not read ${filePath}: ${reason(cause)}`,
      }),
  })

const render = (filePath: string, body: string, footer: string) =>
  [`<path>${filePath}</path>`, "<content>", body, "</content>", "", footer].join("\n")

export const readTool = make<Input>({
  description: DESCRIPTION,
  input: Input,
  execute: (input, context) =>
    Effect.gen(function* () {
      const filePath = isAbsolute(input.filePath) ? input.filePath : resolve(context.directory, input.filePath)
      const title = label(filePath, context.directory)

      const stats = yield* Effect.tryPromise({ try: () => stat(filePath), catch: errnoCode }).pipe(Effect.either)
      if (Either.isLeft(stats)) {
        // ENOTDIR means a parent component is a file, e.g. reading `notes.txt/inner`.
        if (stats.left === "ENOENT" || stats.left === "ENOTDIR") return yield* missing(filePath)
        return yield* new ToolFailure({
          message: `Cannot access ${filePath}${stats.left === undefined ? "" : ` (${stats.left})`}.`,
        })
      }

      const info = stats.right
      if (info.isDirectory()) {
        return yield* new ToolFailure({
          message: `${filePath} is a directory, not a file. Read one of the files inside it, or use glob to list its contents.`,
        })
      }
      if (!info.isFile()) {
        return yield* new ToolFailure({ message: `${filePath} is not a regular file and cannot be read.` })
      }

      if (info.size === 0) {
        return {
          title,
          output: render(filePath, "", "(File is empty - 0 lines)"),
          metadata: { path: filePath, totalLines: 0, empty: true },
        }
      }

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

      const sample = yield* Effect.tryPromise({
        try: () => Bun.file(filePath).slice(0, SAMPLE_BYTES).bytes(),
        catch: (cause) => new ToolFailure({ message: `Could not read ${filePath}: ${reason(cause)}` }),
      })
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
        metadata: { path: filePath, lineStart: first, lineEnd: last, totalLines: page.total, truncated: more },
      }
    }),
})
