import { messageID, sessionID } from "@compass/schema"
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect, Result } from "effect"
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { grepTool } from "../src/tool/grep"
import { decode, type Context, type Result as ToolResult, type ToolFailure } from "../src/tool/tool"

const roots: string[] = []

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "compass-grep-"))
  roots.push(root)
  mkdirSync(join(root, "sub"), { recursive: true })
  writeFileSync(join(root, "alpha.ts"), "const alpha = 1\n// TODO: alpha\n")
  writeFileSync(join(root, "sub", "beta.ts"), "export function beta() {\n  return 2 // TODO: beta\n}\n")
  writeFileSync(join(root, "sub", "gamma.txt"), "plain text\nTODO: gamma\n")
  // Leading NUL byte: both ripgrep and the fallback must treat this as binary.
  writeFileSync(join(root, "blob.bin"), new Uint8Array([0, 1, 2, ...Buffer.from("TODO: blob\n", "utf8")]))
  return root
}

const context = (directory: string, signal?: AbortSignal): Context => ({
  sessionID: sessionID(),
  messageID: messageID(),
  callID: "call_grep",
  directory,
  abort: signal ?? new AbortController().signal,
})

interface Input {
  readonly pattern: string
  readonly path?: string
  readonly include?: string
  readonly limit?: number
}

const settle = (input: Input, directory: string, signal?: AbortSignal) =>
  Effect.runPromise(grepTool.execute(input, context(directory, signal)).pipe(Effect.result))

const succeed = async (input: Input, directory: string) => {
  const result = await settle(input, directory)
  if (Result.isFailure(result)) throw new Error(`expected success, got: ${result.failure.message}`)
  return result.success
}

const fail = async (input: Input, directory: string, signal?: AbortSignal) => {
  const result = await settle(input, directory, signal)
  if (Result.isSuccess(result)) throw new Error(`expected failure, got: ${result.success.output}`)
  return result.failure
}

/** Distinct file paths in the order the output lists them. */
const matchedFiles = (result: ToolResult) => {
  const paths = result.output
    .split("\n")
    .map((line) => /^(.+?):\d+:/.exec(line)?.[1])
    .filter((path): path is string => path !== undefined)
  return [...new Set(paths)]
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

const originalPath = process.env["PATH"] ?? ""
const ripgrepInstalled = Bun.which("rg", { PATH: originalPath }) !== null

// Both engines are exercised against the same expectations. `PATH=""` makes the
// binary lookup fail for real, which is the only thing that selects the fallback.
const engines = [
  { name: "ripgrep", path: originalPath, enabled: ripgrepInstalled },
  { name: "fallback", path: "", enabled: true },
]

for (const engine of engines) {
  describe.skipIf(!engine.enabled)(`grepTool (${engine.name})`, () => {
    beforeEach(() => {
      process.env["PATH"] = engine.path
    })
    afterEach(() => {
      process.env["PATH"] = originalPath
    })

    test("uses the expected engine", async () => {
      const result = await succeed({ pattern: "TODO" }, fixture())
      expect(result.metadata?.["engine"]).toBe(engine.name)
    })

    test("finds matches across the tree and reports the total", async () => {
      const root = fixture()
      const result = await succeed({ pattern: "TODO" }, root)

      expect(result.metadata?.["matches"]).toBe(3)
      expect(result.metadata?.["files"]).toBe(3)
      expect(result.metadata?.["capped"]).toBe(false)
      expect(result.output).toStartWith("Found 3 matches in 3 files")
      expect(result.title).toBe("TODO")
    })

    test("emits absolute path:line:text lines", async () => {
      const root = fixture()
      const result = await succeed({ pattern: "TODO: alpha" }, root)

      expect(result.output).toContain(`${join(root, "alpha.ts")}:2:// TODO: alpha`)
      expect(result.output).toStartWith("Found 1 match in 1 file")
    })

    test("skips binary files", async () => {
      const result = await succeed({ pattern: "TODO" }, fixture())
      expect(result.output).not.toContain("blob.bin")
    })

    test("filters with a slashless include glob at any depth", async () => {
      const root = fixture()
      const result = await succeed({ pattern: "TODO", include: "*.ts" }, root)

      expect(result.metadata?.["matches"]).toBe(2)
      expect(result.output).toContain(join(root, "alpha.ts"))
      expect(result.output).toContain(join(root, "sub", "beta.ts"))
      expect(result.output).not.toContain("gamma.txt")
    })

    test("filters with a brace include glob", async () => {
      const result = await succeed({ pattern: "TODO", include: "*.{txt,none}" }, fixture())
      expect(result.metadata?.["matches"]).toBe(1)
      expect(result.output).toContain("gamma.txt")
    })

    test("scopes the search to a relative subdirectory", async () => {
      const root = fixture()
      const result = await succeed({ pattern: "TODO", path: "sub" }, root)

      expect(result.metadata?.["matches"]).toBe(2)
      expect(result.output).not.toContain("alpha.ts")
    })

    test("searches a single file when path points at one", async () => {
      const root = fixture()
      const result = await succeed({ pattern: "TODO", path: join(root, "sub", "gamma.txt") }, root)

      expect(result.metadata?.["matches"]).toBe(1)
      expect(result.output).toContain(`${join(root, "sub", "gamma.txt")}:2:TODO: gamma`)
    })

    test("treats regex metacharacters as regex, not literals", async () => {
      const root = fixture()
      const result = await succeed({ pattern: "function\\s+\\w+", include: "*.ts" }, root)

      expect(result.metadata?.["matches"]).toBe(1)
      expect(result.output).toContain(join(root, "sub", "beta.ts"))
    })

    test("reports no matches as a result, not a failure", async () => {
      const root = fixture()
      const result = await succeed({ pattern: "definitely_not_present_anywhere" }, root)

      expect(result.metadata?.["matches"]).toBe(0)
      expect(result.output).toContain("No matches found")
      expect(result.output).toContain(root)
    })

    test("caps results at the limit and says so", async () => {
      const root = fixture()
      writeFileSync(join(root, "many.txt"), Array.from({ length: 10 }, (_, i) => `TODO line ${i}`).join("\n"))
      const result = await succeed({ pattern: "TODO line", limit: 3 }, root)

      expect(result.metadata?.["matches"]).toBe(3)
      expect(result.metadata?.["capped"]).toBe(true)
      expect(result.output).toContain("Capped at 3 matches")
      expect(result.output.split("\n").filter((line) => line.includes("many.txt:"))).toHaveLength(3)
    })

    test("does not claim capping when the match count equals the limit", async () => {
      const result = await succeed({ pattern: "TODO", limit: 3 }, fixture())

      expect(result.metadata?.["matches"]).toBe(3)
      expect(result.metadata?.["capped"]).toBe(false)
      expect(result.output).not.toContain("Capped at")
    })

    test("orders files by modification time, newest first", async () => {
      const root = fixture()
      const older = new Date(Date.now() - 60_000)
      const oldest = new Date(Date.now() - 120_000)
      utimesSync(join(root, "sub", "beta.ts"), oldest, oldest)
      utimesSync(join(root, "sub", "gamma.txt"), older, older)

      const result = await succeed({ pattern: "TODO" }, root)
      expect(matchedFiles(result)).toEqual([
        join(root, "alpha.ts"),
        join(root, "sub", "gamma.txt"),
        join(root, "sub", "beta.ts"),
      ])
    })

    test("keeps every match of a file together and in line order", async () => {
      const root = fixture()
      writeFileSync(join(root, "alpha.ts"), "TODO one\nfiller\nTODO two\n")
      const result = await succeed({ pattern: "TODO", include: "alpha.ts" }, root)

      expect(result.output.split("\n").slice(2)).toEqual([
        `${join(root, "alpha.ts")}:1:TODO one`,
        `${join(root, "alpha.ts")}:3:TODO two`,
      ])
    })

    test("fails with the regex error for an invalid pattern", async () => {
      const error = await fail({ pattern: "[unclosed" }, fixture())
      expect(error._tag).toBe("ToolFailure")
      expect(error.message.toLowerCase()).toContain("regex")
    })

    test("fails when the search path does not exist", async () => {
      const root = fixture()
      const error = await fail({ pattern: "TODO", path: "missing-dir" }, root)
      expect(error.message).toContain("does not exist")
      expect(error.message).toContain(join(root, "missing-dir"))
    })

    test("fails fast on an already aborted signal", async () => {
      const controller = new AbortController()
      controller.abort()
      const error = await fail({ pattern: "TODO" }, fixture(), controller.signal)
      expect(error.message).toBe("Search aborted")
    })
  })
}

describe("grepTool contract", () => {
  const run = <A>(effect: Effect.Effect<A, ToolFailure>) => Effect.runPromise(effect.pipe(Effect.result))

  test("requires a pattern", async () => {
    const decoded = await run(decode(grepTool, { path: "." }))
    expect(Result.isFailure(decoded)).toBe(true)
  })

  test("rejects a limit outside the supported range", async () => {
    expect(Result.isFailure(await run(decode(grepTool, { pattern: "x", limit: 0 })))).toBe(true)
    expect(Result.isFailure(await run(decode(grepTool, { pattern: "x", limit: 1.5 })))).toBe(true)
    expect(Result.isFailure(await run(decode(grepTool, { pattern: "x", limit: 5000 })))).toBe(true)
    expect(Result.isSuccess(await run(decode(grepTool, { pattern: "x", limit: 25 })))).toBe(true)
  })

  test("documents every parameter for the model", () => {
    expect(grepTool.description.length).toBeGreaterThan(200)
    for (const key of ["pattern", "path", "include", "limit"]) expect(grepTool.description).toContain(key)
  })
})
