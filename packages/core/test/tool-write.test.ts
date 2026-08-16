import { MessageID, SessionID } from "@compass/schema"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import type { Context } from "../src/tool/tool"
import { ToolFailure } from "../src/tool/tool"
import { writeTool } from "../src/tool/write"

let directory: string

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "compass-write-"))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

const context = (overrides: Partial<Context> = {}): Context => ({
  sessionID: SessionID.make("ses_write_test"),
  messageID: MessageID.make("msg_write_test"),
  callID: "call_write_test",
  directory,
  abort: new AbortController().signal,
  ...overrides,
})

const write = (input: { filePath: string; content: string }, overrides?: Partial<Context>) =>
  Effect.runPromise(writeTool.execute(input, context(overrides)))

const writeFailure = (input: { filePath: string; content: string }, overrides?: Partial<Context>) =>
  Effect.runPromise(writeTool.execute(input, context(overrides)).pipe(Effect.flip))

describe("writeTool", () => {
  test("shares the edit permission so approving edits covers overwrites", () => {
    expect(writeTool.permission).toBe("edit")
  })

  test("creates a new file and reports that it was created", async () => {
    const filePath = path.join(directory, "hello.txt")
    const result = await write({ filePath, content: "hello\nworld\n" })

    expect(readFileSync(filePath, "utf8")).toBe("hello\nworld\n")
    expect(result.output).toContain("Created")
    expect(result.output).not.toContain("Overwrote")
    expect(result.output).toContain("2 lines")
    expect(result.title).toBe("hello.txt")
    expect(result.metadata?.existed).toBe(false)
    expect(result.metadata?.bytes).toBe(12)
  })

  test("overwrites an existing file entirely and reports the previous size", async () => {
    const filePath = path.join(directory, "notes.md")
    writeFileSync(filePath, "a much longer original body")

    const result = await write({ filePath, content: "short" })

    expect(readFileSync(filePath, "utf8")).toBe("short")
    expect(result.output).toContain("Overwrote")
    expect(result.output).toContain("previous size 27 bytes")
    expect(result.metadata?.existed).toBe(true)
  })

  test("creates missing parent directories and says which one it made", async () => {
    const filePath = path.join(directory, "deeply", "nested", "dir", "file.ts")
    const result = await write({ filePath, content: "export const a = 1\n" })

    expect(readFileSync(filePath, "utf8")).toBe("export const a = 1\n")
    expect(result.output).toContain("Created parent directory")
    expect(result.metadata?.createdDirectory).toBe(path.join(directory, "deeply"))
  })

  test("does not claim to have created a directory when the parent already exists", async () => {
    const result = await write({ filePath: path.join(directory, "flat.txt"), content: "x" })
    expect(result.output).not.toContain("parent directory")
    expect(result.metadata?.createdDirectory).toBeUndefined()
  })

  test("resolves a relative path against the session directory", async () => {
    const result = await write({ filePath: "src/index.ts", content: "// entry\n" })

    expect(readFileSync(path.join(directory, "src", "index.ts"), "utf8")).toBe("// entry\n")
    expect(result.title).toBe(path.join("src", "index.ts"))
    expect(result.metadata?.filepath).toBe(path.join(directory, "src", "index.ts"))
  })

  test("fails clearly when the path is an existing directory", async () => {
    const filePath = path.join(directory, "somedir")
    mkdirSync(filePath)

    const failure = await writeFailure({ filePath, content: "nope" })

    expect(failure).toBeInstanceOf(ToolFailure)
    expect(failure.message).toContain("is a directory")
    expect(failure.message).toContain(filePath)
  })

  test("fails clearly when a parent path component is a file", async () => {
    const blocker = path.join(directory, "blocker")
    writeFileSync(blocker, "i am a file")

    const failure = await writeFailure({ filePath: path.join(blocker, "child.txt"), content: "nope" })

    expect(failure).toBeInstanceOf(ToolFailure)
    expect(failure.message).toContain("parent directory")
    expect(failure.message).toContain(blocker)
  })

  test("refuses to write when the turn is already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    const filePath = path.join(directory, "aborted.txt")

    const failure = await writeFailure({ filePath, content: "x" }, { abort: controller.signal })

    expect(failure).toBeInstanceOf(ToolFailure)
    expect(() => readFileSync(filePath, "utf8")).toThrow()
  })

  test("writes empty content and reports zero lines", async () => {
    const filePath = path.join(directory, "empty.txt")
    const result = await write({ filePath, content: "" })

    expect(readFileSync(filePath, "utf8")).toBe("")
    expect(result.output).toContain("0 lines")
    expect(result.metadata?.bytes).toBe(0)
  })

  test("counts bytes rather than characters for non-ascii content", async () => {
    const filePath = path.join(directory, "unicode.txt")
    const result = await write({ filePath, content: "héllo — 世界" })

    expect(readFileSync(filePath, "utf8")).toBe("héllo — 世界")
    expect(result.metadata?.bytes).toBe(Buffer.byteLength("héllo — 世界", "utf-8"))
    expect(result.output).toContain("1 line,")
  })

  test("preserves content verbatim, including trailing whitespace", async () => {
    const filePath = path.join(directory, "verbatim.txt")
    const content = "line one  \n\tindented\n\n"
    await write({ filePath, content })

    expect(readFileSync(filePath, "utf8")).toBe(content)
  })
})
