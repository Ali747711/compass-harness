// Adapted from opencode (MIT). Source: packages/opencode/src/tool/grep.ts, grep.txt
// and packages/core/src/ripgrep.ts
// https://github.com/anomalyco/opencode — see licenses/opencode-MIT.txt
//
// opencode ships a vendored ripgrep binary and a core-owned execution service.
// Neither exists here yet, so this tool uses whatever `rg` is on PATH and falls
// back to a Bun walk when there is none — a missing binary must not break search.

import { statSync } from "node:fs"
import { dirname, isAbsolute, resolve } from "node:path"
import { Effect, Option, Schema } from "effect"
import { ToolFailure, make, type Context, type Result } from "./tool"

const DESCRIPTION = `Search file contents with a regular expression.

- Fast content search that works at any codebase size. Uses ripgrep when it is on PATH and an
  equivalent built-in walk when it is not.
- Searches file CONTENTS. To find files by name use glob; to open a file you already know use read.
- Supports full regex syntax (eg. "log.*Error", "function\\s+\\w+", "TODO\\(\\w+\\)"). The pattern is
  passed through unescaped, so escape any metacharacter you mean literally.
- "path" scopes the search to a directory or a single file and defaults to the session working
  directory. Relative paths resolve against it.
- "include" filters by file glob (eg. "*.ts", "*.{ts,tsx}", "src/**/*.go"). A glob with no slash
  matches at any depth.
- "limit" caps returned matches (default 100). The output states when results were capped, so widen
  the path or tighten the pattern rather than assuming you saw everything.
- Results are "path:line:text", grouped per file, most recently modified files first.
- Binary files and .git are skipped; with ripgrep present, gitignored files are skipped too.
- Prefer one well-aimed search over many narrow ones. If answering the question needs several rounds
  of globbing and grepping, delegate the whole search to a subagent instead.`

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 1000
const MAX_LINE_CHARS = 2000
// A single ripgrep JSON record this large means the match sits on a minified line;
// its text is noise to the model, so the record is skipped rather than parsed.
const MAX_RECORD_BYTES = 64 * 1024
const BINARY_SNIFF_BYTES = 8 * 1024
// The fallback reads whole files into memory where ripgrep would stream them.
const MAX_FALLBACK_FILE_BYTES = 10 * 1024 * 1024
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules"])

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
  readonly text: string
}

interface Outcome {
  readonly hits: readonly Hit[]
  readonly capped: boolean
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

const clip = (text: string) =>
  text.length <= MAX_LINE_CHARS ? text : `${text.slice(0, MAX_LINE_CHARS).replace(/[\uD800-\uDBFF]$/, "")}...`

const resolveTarget = (requested: string | undefined, directory: string) =>
  Effect.gen(function* () {
    const target =
      requested === undefined ? directory : isAbsolute(requested) ? requested : resolve(directory, requested)
    const info = yield* Effect.try({
      try: () => statSync(target, { throwIfNoEntry: false }),
      catch: (cause) => new ToolFailure({ message: `Cannot search ${target}: ${message(cause)}` }),
    })
    if (info === undefined) return yield* new ToolFailure({ message: `Search path does not exist: ${target}` })
    if (info.isDirectory()) return { root: target, cwd: target }
    return { root: target, cwd: dirname(target), file: target }
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

const parseRecord = (line: string, cwd: string): Hit | undefined => {
  if (line.length === 0 || Buffer.byteLength(line, "utf8") > MAX_RECORD_BYTES) return undefined
  const record = decodeRecord(line)
  if (Option.isNone(record)) return undefined
  return {
    path: resolve(cwd, record.value.data.path.text),
    line: record.value.data.line_number,
    text: record.value.data.lines.text,
  }
}

const runRipgrep = (binary: string, search: Search) =>
  Effect.gen(function* () {
    const collected = yield* Effect.tryPromise({
      try: async () => {
        const args = [
          "--no-config",
          "--json",
          "--hidden",
          "--no-messages",
          "--glob=!**/.git/**",
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
        let pending = ""
        for await (const chunk of proc.stdout) {
          const lines = (pending + decoder.decode(chunk, { stream: true })).split("\n")
          pending = lines.pop() ?? ""
          for (const line of lines) {
            const hit = parseRecord(line, search.cwd)
            if (hit === undefined) continue
            if (hits.length >= search.limit) {
              capped = true
              break
            }
            hits.push(hit)
          }
          if (capped) break
        }
        search.signal.removeEventListener("abort", kill)
        if (capped) {
          proc.kill()
          return { hits, capped, code: 0, stderr: "" }
        }
        return { hits, capped, code: await proc.exited, stderr: (await stderr).trim() }
      },
      catch: (cause) => new ToolFailure({ message: `Search failed: ${message(cause)}` }),
    })

    // A killed process reports a signal exit code, so abort is settled by the caller.
    if (search.signal.aborted) return { hits: collected.hits, capped: collected.capped } satisfies Outcome

    // rg exits 1 for "no matches" and 2 when some files could not be read; a code 2 that
    // produced nothing is a real failure (an unparseable pattern lands here).
    if (collected.code === 2 && collected.hits.length === 0 && collected.stderr.length > 0)
      return yield* new ToolFailure({ message: collected.stderr })
    if (collected.code > 2)
      return yield* new ToolFailure({
        message: collected.stderr.length > 0 ? collected.stderr : `ripgrep exited with code ${collected.code}`,
      })
    return { hits: collected.hits, capped: collected.capped } satisfies Outcome
  })

const listFallbackFiles = (search: Search) =>
  Effect.tryPromise({
    try: async () => {
      // ripgrep treats a slashless glob as matching at any depth; Bun.Glob anchors it.
      const pattern =
        search.include === undefined ? "**/*" : search.include.includes("/") ? search.include : `**/${search.include}`
      const scanned: string[] = []
      for await (const entry of new Bun.Glob(pattern).scan({ cwd: search.cwd, dot: true, onlyFiles: true })) {
        if (entry.split("/").some((segment) => SKIPPED_DIRECTORIES.has(segment))) continue
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
        const decoder = new TextDecoder()
        let capped = false
        for (const path of files) {
          if (capped || search.signal.aborted) break
          const file = Bun.file(path)
          if (file.size > MAX_FALLBACK_FILE_BYTES) continue
          const bytes = new Uint8Array(await file.arrayBuffer())
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
            hits.push({ path, line: index + 1, text: line })
          }
        }
        return { hits, capped } satisfies Outcome
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
  description: DESCRIPTION,
  input: Parameters,
  execute: (input, context: Context): Effect.Effect<Result, ToolFailure> =>
    Effect.gen(function* () {
      if (context.abort.aborted) return yield* new ToolFailure({ message: "Search aborted" })
      const limit = input.limit ?? DEFAULT_LIMIT
      const target = yield* resolveTarget(input.path, context.directory)
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

      if (outcome.hits.length === 0)
        return {
          title: input.pattern,
          output: `No matches found for pattern "${input.pattern}" in ${target.root}${input.include === undefined ? "" : ` (include: ${input.include})`}`,
          metadata: { matches: 0, files: 0, capped: false, engine },
        }

      const groups = group(outcome.hits)
      const total = outcome.hits.length
      const lines = [
        `Found ${total} ${total === 1 ? "match" : "matches"} in ${groups.length} ${groups.length === 1 ? "file" : "files"}`,
        "",
      ]
      for (const entry of groups) {
        for (const hit of entry.hits) lines.push(`${hit.path}:${hit.line}:${clip(hit.text.trim())}`)
      }
      if (outcome.capped) {
        lines.push("")
        lines.push(`(Capped at ${limit} matches — more exist. Narrow the pattern, set path, or use include.)`)
      }

      return {
        title: input.pattern,
        output: lines.join("\n"),
        metadata: { matches: total, files: groups.length, capped: outcome.capped, engine },
      }
    }),
})
