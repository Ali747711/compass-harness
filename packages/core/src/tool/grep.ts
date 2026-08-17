// Adapted from opencode (MIT). Source: packages/opencode/src/tool/grep.ts, grep.txt
// and packages/core/src/ripgrep.ts
// https://github.com/anomalyco/opencode — see licenses/opencode-MIT.txt
//
// opencode ships a vendored ripgrep binary and a core-owned execution service.
// Neither exists here yet, so this tool uses whatever `rg` is on PATH and falls
// back to a Bun walk when there is none — a missing binary must not break search.
//
// The two engines are held to one contract: same skipped directories, same
// treatment of a line too long to display, and nothing dropped without saying so.
// A search that could not look at part of the tree reports that in its output;
// answering "no matches" over data you never read is a lie the model cannot detect.

import { statSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { Effect, Option, Schema } from "effect"
import { resolveWithin } from "./path-guard"
import { ToolFailure, make, render as renderDescription, type Context, type Result } from "./tool"
import DESCRIPTION from "./grep.txt"

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 1000
const MAX_LINE_CHARS = 2000
// Past this a match sits on a minified line: the text is noise to the model, and
// materializing it would cost more memory than the location is worth. The match is
// still reported, with OVERSIZE_NOTICE standing in for the text.
const MAX_RECORD_BYTES = 64 * 1024
const OVERSIZE_NOTICE = "(match omitted: line too long to display; use read to inspect this file)"
const BINARY_SNIFF_BYTES = 8 * 1024
// The fallback reads whole files into memory where ripgrep would stream them.
const MAX_FALLBACK_FILE_BYTES = 10 * 1024 * 1024
const SKIPPED_DIRECTORIES = ["node_modules", ".git"] as const
/** Paths named in a skip note before it collapses into a count. */
const NOTE_SAMPLE = 5

const Parameters = Schema.Struct({
  pattern: Schema.String.annotate({ description: "The regex pattern to search for in file contents" }),
  path: Schema.optionalKey(Schema.String).annotate({
    description: "File or directory to search. Defaults to the current working directory.",
  }),
  include: Schema.optionalKey(Schema.String).annotate({
    description: 'File glob to restrict the search to (e.g. "*.js", "*.{ts,tsx}")',
  }),
  limit: Schema.optionalKey(
    Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: MAX_LIMIT })),
  ).annotate({
    description: `Maximum number of matches to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`,
  }),
})

type Params = typeof Parameters.Type

interface Hit {
  readonly path: string
  readonly line: number
  /** Display-ready: already trimmed, and already bounded to MAX_LINE_CHARS. */
  readonly text: string
}

interface Outcome {
  readonly hits: readonly Hit[]
  readonly capped: boolean
  /** Everything the engine could not look at. Rendered into the output verbatim. */
  readonly notes: readonly string[]
}

interface Search {
  readonly cwd: string
  readonly file?: string
  readonly pattern: string
  readonly include?: string
  readonly limit: number
  readonly signal: AbortSignal
}

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

/** Mirrors glob.ts: a directory the caller named explicitly is not one they want skipped. */
const skippedDirectories = (include: string | undefined) =>
  SKIPPED_DIRECTORIES.filter((name) => include === undefined || !include.includes(name))

const clip = (text: string) =>
  text.length <= MAX_LINE_CHARS
    ? text
    : `${text.slice(0, MAX_LINE_CHARS).replace(/[\uD800-\uDBFF]$/, "")}... (line truncated at ${MAX_LINE_CHARS} of ${text.length} characters)`

const display = (raw: string) =>
  Buffer.byteLength(raw, "utf8") > MAX_RECORD_BYTES ? OVERSIZE_NOTICE : clip(raw.trim())

const listNote = (headline: string, entries: readonly string[]) => {
  const shown = entries.slice(0, NOTE_SAMPLE)
  const rest = entries.length - shown.length
  return [
    `${entries.length} ${headline}:`,
    ...shown.map((entry) => `  - ${entry}`),
    ...(rest > 0 ? [`  - (and ${rest} more)`] : []),
  ].join("\n")
}

interface Target {
  readonly root: string
  readonly cwd: string
  readonly file?: string
}

const resolveTarget = (requested: string | undefined, context: Context) =>
  Effect.gen(function* () {
    // Models pass "" for an optional path; that means "the default", not an error.
    const target = requested === undefined || requested.trim() === "" ? "." : requested
    const probe = resolve(context.directory, target)
    const info = yield* Effect.try({
      try: () => statSync(probe, { throwIfNoEntry: false }),
      catch: (cause) => new ToolFailure({ message: `Cannot search ${probe}: ${message(cause)}` }),
    })
    if (info === undefined) return yield* new ToolFailure({ message: `Search path does not exist: ${probe}` })

    // Reading outside the session directory is a deliberate choice, so ask first.
    const root = yield* resolveWithin(context, target, { kind: info.isDirectory() ? "directory" : "file" })
    if (info.isDirectory()) return { root, cwd: root } satisfies Target
    return { root, cwd: dirname(root), file: root } satisfies Target
  })

const RipgrepMatch = Schema.Struct({
  type: Schema.Literal("match"),
  data: Schema.Struct({
    path: Schema.Struct({ text: Schema.String }),
    lines: Schema.Struct({ text: Schema.String }),
    line_number: Schema.Number,
  }),
})

// Non-match records (begin/end/summary) and unparseable lines decode to None and are dropped.
const decodeRecord = Schema.decodeUnknownOption(Schema.fromJsonString(RipgrepMatch))
const decodeJsonString = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.String))

type Parsed =
  | { readonly kind: "hit"; readonly hit: Hit }
  | { readonly kind: "other" }
  /** Oversize and not even locatable. Counted so it can be reported, never dropped. */
  | { readonly kind: "unlocatable" }

const OTHER: Parsed = { kind: "other" }
const UNLOCATABLE: Parsed = { kind: "unlocatable" }

// `path` is the first field of a match record, so a bounded prefix always holds it.
const RECORD_HEAD = 4096
const RECORD_PATH = /^\{"type":"match","data":\{"path":\{"text":("(?:[^"\\]|\\.)*")\}/
// Emitted after the line text, so the last occurrence is ripgrep's and not file content.
const RECORD_LINE = /"line_number":(\d+),"absolute_offset":\d+,"submatches":\[/g

/**
 * Locates an oversize record without parsing it. JSON.parse would duplicate a
 * multi-megabyte line in memory to produce text that is then thrown away; scanning
 * for the two fields that matter costs one linear pass and no allocation.
 */
const salvage = (record: string, cwd: string): Parsed => {
  const quoted = RECORD_PATH.exec(record.slice(0, RECORD_HEAD))?.[1]
  if (quoted === undefined) return UNLOCATABLE
  const path = decodeJsonString(quoted)
  if (Option.isNone(path)) return UNLOCATABLE
  let number: string | undefined
  for (const match of record.matchAll(RECORD_LINE)) number = match[1]
  if (number === undefined) return UNLOCATABLE
  return { kind: "hit", hit: { path: resolve(cwd, path.value), line: Number(number), text: OVERSIZE_NOTICE } }
}

const parseRecord = (record: string, cwd: string): Parsed => {
  if (record.length === 0) return OTHER
  if (Buffer.byteLength(record, "utf8") > MAX_RECORD_BYTES) return salvage(record, cwd)
  const decoded = decodeRecord(record)
  if (Option.isNone(decoded)) return OTHER
  return {
    kind: "hit",
    hit: {
      path: resolve(cwd, decoded.value.data.path.text),
      line: decoded.value.data.line_number,
      text: display(decoded.value.data.lines.text),
    },
  }
}

const runRipgrep = (binary: string, search: Search) =>
  Effect.gen(function* () {
    const collected = yield* Effect.tryPromise({
      try: async () => {
        const skipped = skippedDirectories(search.include)
        const args = [
          "--no-config",
          "--json",
          "--hidden",
          // An include glob naming a skipped directory is an explicit request for it,
          // and .gitignore would otherwise defeat that where the built-in walk cannot.
          ...(skipped.length === SKIPPED_DIRECTORIES.length ? [] : ["--no-ignore"]),
          ...skipped.map((name) => `--glob=!**/${name}/**`),
          ...(search.include === undefined ? [] : [`--glob=${search.include}`]),
          "--",
          search.pattern,
          search.file ?? ".",
        ]
        const proc = Bun.spawn([binary, ...args], {
          cwd: search.cwd,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        })
        const kill = () => proc.kill()
        search.signal.addEventListener("abort", kill, { once: true })
        // Drained concurrently with stdout so a chatty stderr cannot deadlock the pipe,
        // and never left rejecting when the capped branch abandons it.
        const stderr = new Response(proc.stderr).text().catch(() => "")

        const hits: Hit[] = []
        const decoder = new TextDecoder()
        let capped = false
        let unlocatable = 0
        let records = 0
        let pending = ""

        const take = (record: string) => {
          if (record.length === 0) return
          records += 1
          const parsed = parseRecord(record, search.cwd)
          if (parsed.kind === "unlocatable") {
            unlocatable += 1
            return
          }
          if (parsed.kind !== "hit") return
          if (hits.length >= search.limit) {
            capped = true
            return
          }
          hits.push(parsed.hit)
        }

        for await (const chunk of proc.stdout) {
          if (search.signal.aborted) break
          const lines = (pending + decoder.decode(chunk, { stream: true })).split("\n")
          pending = lines.pop() ?? ""
          for (const line of lines) {
            take(line)
            if (capped) break
          }
          if (capped) break
        }
        // A final record without a trailing newline would otherwise be lost.
        if (!capped && !search.signal.aborted) take(pending + decoder.decode())

        search.signal.removeEventListener("abort", kill)
        if (capped) {
          proc.kill()
          return { hits, capped, unlocatable, records, code: 0, stderr: "" }
        }
        return { hits, capped, unlocatable, records, code: await proc.exited, stderr: (await stderr).trim() }
      },
      catch: (cause) => new ToolFailure({ message: `Search failed: ${message(cause)}` }),
    })

    // A killed process reports a signal exit code, so abort is settled by the caller.
    if (search.signal.aborted) return { hits: collected.hits, capped: collected.capped, notes: [] } satisfies Outcome

    // rg exits 2 both for a startup failure (an unparseable pattern) and for a search
    // that ran but could not read some files. It emits at least a summary record
    // whenever it actually searched, so "no records at all" separates the two; the
    // second case is a result, and its stderr becomes a note below. Anything above 2
    // is an abnormal exit, where partial output cannot be trusted to be all of it.
    if (collected.code > 2 || (collected.code === 2 && collected.records === 0))
      return yield* new ToolFailure({
        message: collected.stderr.length > 0 ? collected.stderr : `ripgrep exited with code ${collected.code}`,
      })

    const problems = collected.stderr
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
    const notes = [
      ...(collected.unlocatable > 0
        ? [`${collected.unlocatable} matching line(s) were too large to report and could not be located.`]
        : []),
      ...(problems.length > 0 ? [listNote("path(s) could not be searched", problems)] : []),
    ]
    return { hits: collected.hits, capped: collected.capped, notes } satisfies Outcome
  })

const listFallbackFiles = (search: Search) =>
  Effect.tryPromise({
    try: async () => {
      // ripgrep treats a slashless glob as matching at any depth; Bun.Glob anchors it.
      const pattern =
        search.include === undefined ? "**/*" : search.include.includes("/") ? search.include : `**/${search.include}`
      const skipped = new Set<string>(skippedDirectories(search.include))
      const scanned: string[] = []
      for await (const entry of new Bun.Glob(pattern).scan({ cwd: search.cwd, dot: true, onlyFiles: true })) {
        // Aborting mid-walk returns a short list; the caller turns that into a failure.
        if (search.signal.aborted) break
        const directories = entry.split(/[/\\]/).slice(0, -1)
        if (directories.some((segment) => skipped.has(segment))) continue
        scanned.push(entry)
      }
      return scanned.sort().map((entry) => resolve(search.cwd, entry))
    },
    catch: (cause) => new ToolFailure({ message: `Cannot list files under ${search.cwd}: ${message(cause)}` }),
  })

const runFallback = (search: Search) =>
  Effect.gen(function* () {
    const regex = yield* Effect.try({
      try: () => new RegExp(search.pattern),
      catch: (cause) => new ToolFailure({ message: `Invalid regex pattern: ${message(cause)}` }),
    })
    const files = search.file === undefined ? yield* listFallbackFiles(search) : [search.file]

    return yield* Effect.tryPromise({
      try: async () => {
        const hits: Hit[] = []
        const unreadable: string[] = []
        const oversized: string[] = []
        const decoder = new TextDecoder()
        let capped = false

        for (const path of files) {
          if (capped || search.signal.aborted) break
          const file = Bun.file(path)
          if (file.size > MAX_FALLBACK_FILE_BYTES) {
            oversized.push(path)
            continue
          }
          // EACCES, or a file deleted mid-walk, skips that file — never the search.
          const buffer = await file.arrayBuffer().catch(() => undefined)
          if (search.signal.aborted) break
          if (buffer === undefined) {
            unreadable.push(path)
            continue
          }
          const bytes = new Uint8Array(buffer)
          // A NUL byte in the head of the file is ripgrep's binary heuristic too.
          if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) continue
          const lines = decoder.decode(bytes).split("\n")
          for (let index = 0; index < lines.length; index++) {
            const line = lines[index] ?? ""
            if (!regex.test(line)) continue
            if (hits.length >= search.limit) {
              capped = true
              break
            }
            hits.push({ path, line: index + 1, text: display(line) })
          }
        }

        const notes = [
          ...(oversized.length > 0
            ? [
                listNote(
                  `file(s) over ${MAX_FALLBACK_FILE_BYTES / (1024 * 1024)} MB were not searched (the built-in walk reads whole files; install ripgrep to search them)`,
                  oversized,
                ),
              ]
            : []),
          ...(unreadable.length > 0 ? [listNote("file(s) could not be read and were skipped", unreadable)] : []),
        ]
        return { hits, capped, notes } satisfies Outcome
      },
      catch: (cause) => new ToolFailure({ message: `Search failed: ${message(cause)}` }),
    })
  })

const group = (hits: readonly Hit[]) => {
  const byPath = new Map<string, Hit[]>()
  for (const hit of hits) {
    const existing = byPath.get(hit.path)
    if (existing !== undefined) {
      existing.push(hit)
      continue
    }
    byPath.set(hit.path, [hit])
  }
  // Distinct matched files are bounded by `limit`, so one stat apiece stays cheap.
  const modified = new Map(
    [...byPath.keys()].map((path) => [path, statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? 0]),
  )
  const paths = [...byPath.keys()].sort(
    (left, right) => (modified.get(right) ?? 0) - (modified.get(left) ?? 0) || left.localeCompare(right),
  )
  return paths.map((path) => ({ path, hits: byPath.get(path) ?? [] }))
}

export const grepTool = make<Params>({
  description: renderDescription(DESCRIPTION, {
    MAX_LINE_CHARS,
    SKIPPED: SKIPPED_DIRECTORIES.join(" and "),
  }),
  input: Parameters,
  execute: (input, context: Context): Effect.Effect<Result, ToolFailure> =>
    Effect.gen(function* () {
      if (context.abort.aborted) return yield* new ToolFailure({ message: "Search aborted" })
      const limit = input.limit ?? DEFAULT_LIMIT
      const target = yield* resolveTarget(input.path, context)
      const search: Search = {
        cwd: target.cwd,
        file: target.file,
        pattern: input.pattern,
        include: input.include,
        limit,
        signal: context.abort,
      }

      const binary = Bun.which("rg", { PATH: process.env["PATH"] ?? "" })
      const engine = binary === null ? "fallback" : "ripgrep"
      const outcome = binary === null ? yield* runFallback(search) : yield* runRipgrep(binary, search)
      if (context.abort.aborted) return yield* new ToolFailure({ message: "Search aborted" })

      const incomplete = outcome.notes.length > 0
      const scope = `pattern "${input.pattern}" in ${target.root}${input.include === undefined ? "" : ` (include: ${input.include})`}`

      if (outcome.hits.length === 0) {
        // Never a bare "no matches" when part of the tree went unread.
        const headline = incomplete
          ? `No matches found for ${scope}, but the search was incomplete:`
          : `No matches found for ${scope}`
        return {
          title: input.pattern,
          output: [headline, ...(incomplete ? ["", ...outcome.notes] : [])].join("\n"),
          metadata: { matches: 0, files: 0, capped: false, engine, incomplete },
        }
      }

      const groups = group(outcome.hits)
      const total = outcome.hits.length
      const lines = [
        `Found ${total} ${total === 1 ? "match" : "matches"} in ${groups.length} ${groups.length === 1 ? "file" : "files"}`,
        "",
      ]
      for (const entry of groups) {
        for (const hit of entry.hits) lines.push(`${hit.path}:${hit.line}:${hit.text}`)
      }
      if (outcome.capped) {
        lines.push("")
        lines.push(`(Capped at ${limit} matches — more exist. Narrow the pattern, set path, or use include.)`)
      }
      for (const note of outcome.notes) {
        lines.push("")
        lines.push(note)
      }

      return {
        title: input.pattern,
        output: lines.join("\n"),
        metadata: { matches: total, files: groups.length, capped: outcome.capped, engine, incomplete },
      }
    }),
})
