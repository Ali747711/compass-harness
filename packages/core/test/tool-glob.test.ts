import { messageID, sessionID } from "@compass/schema"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { globTool } from "../src/tool/glob"
import { decode, ToolFailure, type Context, type Result } from "../src/tool/tool"

let root = ""

const context = (directory: string): Context => ({
  sessionID: sessionID(),
  messageID: messageID(),
  callID: "call_glob",
  directory,
  abort: new AbortController().signal,
})

interface Input {
  readonly pattern: string
  readonly path?: string
  readonly limit?: number
}

const run = (input: Input, directory = root): Promise<Result> =>
  Effect.runPromise(globTool.execute(input, context(directory)))

const runFailure = (input: Input, directory = root): Promise<ToolFailure> =>
  Effect.runPromise(globTool.execute(input, context(directory)).pipe(Effect.flip))

/** Explicit mtimes keep the ordering assertions deterministic on fast filesystems. */
const write = (relative: string, contents: string, minutesAgo: number) => {
  const file = path.join(root, relative)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, contents)
  const stamp = new Date(Date.now() - minutesAgo * 60_000)
  utimesSync(file, stamp, stamp)
  return file
}

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "compass-glob-"))
  write("src/old.ts", "export const old = 1", 30)
  write("src/newest.ts", "export const newest = 3", 1)
  write("src/nested/middle.ts", "export const middle = 2", 10)
  write("src/notes.md", "# notes", 5)
  write("node_modules/dep/index.ts", "export const dep = 1", 2)
  write("dist/bundle.ts", "export const bundle = 1", 2)
  write(".git/hooks/pre-commit.ts", "export const hook = 1", 2)
})

afterAll(() => {
  if (root !== "") rmSync(root, { recursive: true, force: true })
})

describe("globTool", () => {
  test("finds matching files and returns absolute paths", async () => {
    const result = await run({ pattern: "**/*.ts" })
    const lines = result.output.split("\n")

    expect(lines).toContain(path.join(root, "src/old.ts"))
    expect(lines).toContain(path.join(root, "src/newest.ts"))
    expect(lines).toContain(path.join(root, "src/nested/middle.ts"))
    expect(lines.every((line) => path.isAbsolute(line))).toBe(true)
    expect(result.output).not.toContain("notes.md")
  })

  test("sorts results by modification time, most recent first", async () => {
    const result = await run({ pattern: "src/**/*.ts" })

    expect(result.output.split("\n")).toEqual([
      path.join(root, "src/newest.ts"),
      path.join(root, "src/nested/middle.ts"),
      path.join(root, "src/old.ts"),
    ])
  })

  test("ignores node_modules, dist and .git by default", async () => {
    const result = await run({ pattern: "**/*.ts" })
    // Compared relative to root so a random tmpdir name can never spoof a match.
    const relative = result.output.split("\n").map((line) => path.relative(root, line))

    expect(relative.sort()).toEqual([
      path.join("src", "nested", "middle.ts"),
      path.join("src", "newest.ts"),
      path.join("src", "old.ts"),
    ])
    expect(result.metadata?.matched).toBe(3)
  })

  test("searches an ignored directory when the pattern names it explicitly", async () => {
    const result = await run({ pattern: "node_modules/**/*.ts" })

    expect(result.output).toBe(path.join(root, "node_modules/dep/index.ts"))
    expect(result.metadata?.matched).toBe(1)
  })

  test("caps output at the limit and reports that results were capped", async () => {
    const result = await run({ pattern: "src/**/*.ts", limit: 2 })
    const lines = result.output.split("\n")

    expect(lines[0]).toBe(path.join(root, "src/newest.ts"))
    expect(lines[1]).toBe(path.join(root, "src/nested/middle.ts"))
    expect(result.output).toContain("Showing the 2 most recently modified of 3 matches")
    expect(result.metadata?.count).toBe(2)
    expect(result.metadata?.matched).toBe(3)
    expect(result.metadata?.truncated).toBe(true)
  })

  test("says nothing matched instead of failing when there are no matches", async () => {
    const result = await run({ pattern: "**/*.rs" })

    expect(result.output).toContain("No files matched")
    expect(result.metadata?.count).toBe(0)
    expect(result.metadata?.truncated).toBe(false)
  })

  test("resolves a relative path against the session directory", async () => {
    const result = await run({ pattern: "*.ts", path: "src/nested" })

    expect(result.output).toBe(path.join(root, "src/nested/middle.ts"))
    expect(result.title).toBe(`*.ts in ${path.join("src", "nested")}`)
  })

  test("searches an absolute path outside the session directory", async () => {
    const result = await run({ pattern: "*.ts", path: path.join(root, "src") }, path.join(root, "src/nested"))

    expect(result.output.split("\n")).toEqual([path.join(root, "src/newest.ts"), path.join(root, "src/old.ts")])
  })

  test("fails with ToolFailure when the search path does not exist", async () => {
    const error = await runFailure({ pattern: "**/*.ts", path: "does-not-exist" })

    expect(error).toBeInstanceOf(ToolFailure)
    expect(error.message).toContain("does not exist")
    expect(error.message).toContain("does-not-exist")
  })

  test("fails with ToolFailure when the search path is a file", async () => {
    const error = await runFailure({ pattern: "*.ts", path: "src/old.ts" })

    expect(error).toBeInstanceOf(ToolFailure)
    expect(error.message).toContain("not a directory")
  })

  test("stops the walk when the turn is aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    const error = await Effect.runPromise(
      globTool.execute({ pattern: "**/*.ts" }, { ...context(root), abort: controller.signal }).pipe(Effect.flip),
    )

    expect(error).toBeInstanceOf(ToolFailure)
    expect(error.message).toContain("aborted")
  })

  test("accepts a well-formed input through the declared schema", async () => {
    const decoded = await Effect.runPromise(decode(globTool, { pattern: "**/*.ts", limit: 5 }))

    expect(decoded).toEqual({ pattern: "**/*.ts", limit: 5 })
  })

  test("rejects a non-positive limit at the schema boundary", async () => {
    const error = await Effect.runPromise(Effect.flip(decode(globTool, { pattern: "**/*.ts", limit: 0 })))

    expect(error).toBeInstanceOf(ToolFailure)
    expect(error.message).toContain("Invalid tool input")
  })

  test("rejects a missing pattern at the schema boundary", async () => {
    const error = await Effect.runPromise(Effect.flip(decode(globTool, { path: "src" })))

    expect(error).toBeInstanceOf(ToolFailure)
  })
})
