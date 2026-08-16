import { MessageID, SessionID } from "@compass/schema"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { PermissionDenied, type Request } from "../src/permission/permission"
import type { Context } from "../src/tool/tool"
import { ToolFailure } from "../src/tool/tool"
import { writeTool } from "../src/tool/write"

let directory: string
let outside: string

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "compass-write-"))
  outside = mkdtempSync(path.join(tmpdir(), "compass-write-outside-"))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

/** Grants everything and records what was asked, so a test can assert the tool asked at all. */
const recording =
  (log: Request[]): Context["ask"] =>
  (request) =>
    Effect.sync(() => {
      log.push(request)
    })

/** Refuses everything, mirroring a user who declines the external_directory prompt. */
const denying =
  (log: Request[]): Context["ask"] =>
  (request) => {
    log.push(request)
    return Effect.fail(new PermissionDenied({ permission: request.permission, pattern: request.patterns[0] ?? "*" }))
  }

/**
 * Reports "not aborted" for the first `allowed` reads and aborted afterwards, so a test
 * can pin down exactly how many times the tool samples the signal.
 */
const abortOnRead = (allowed: number): AbortSignal => {
  const signal = new AbortController().signal
  let reads = 0
  Object.defineProperty(signal, "aborted", { get: () => ++reads > allowed })
  return signal
}

const context = (overrides: Partial<Context> = {}): Context => ({
  sessionID: SessionID.make("ses_write_test"),
  messageID: MessageID.make("msg_write_test"),
  callID: "call_write_test",
  directory,
  ask: () => Effect.void,
  abort: new AbortController().signal,
  ...overrides,
})

const write = (input: { filePath: string; content: string }, overrides?: Partial<Context>) =>
  Effect.runPromise(writeTool.execute(input, context(overrides)))

const writeFailure = (input: { filePath: string; content: string }, overrides?: Partial<Context>) =>
  Effect.runPromise(writeTool.execute(input, context(overrides)).pipe(Effect.flip))

describe("writeTool", () => {
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
    expect(result.metadata?.filePath).toBe(path.join(directory, "src", "index.ts"))
  })

  test("names the resolved path metadata key filePath, matching the edit tool", async () => {
    const result = await write({ filePath: "keys.txt", content: "x" })

    expect(result.metadata?.filePath).toBe(path.join(directory, "keys.txt"))
    expect(result.metadata).not.toHaveProperty("filepath")
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

  describe("byte pluralisation", () => {
    test("says 1 byte, not 1 bytes", async () => {
      const result = await write({ filePath: path.join(directory, "one.txt"), content: "x" })

      expect(result.output).toContain("1 byte)")
      expect(result.output).not.toContain("1 bytes")
    })

    test("pluralises the previous size too", async () => {
      const filePath = path.join(directory, "grow.txt")
      writeFileSync(filePath, "x")

      const result = await write({ filePath, content: "xyz" })

      expect(result.output).toContain("previous size 1 byte)")
      expect(result.output).not.toContain("1 bytes")
    })
  })

  describe("containment", () => {
    test("asks before writing above the session directory and refuses when denied", async () => {
      const log: Request[] = []
      // Nested so the two-level escape still lands inside the fixture that afterEach removes.
      const session = path.join(directory, "a", "b")
      mkdirSync(session, { recursive: true })
      const escaped = path.join(session, "..", "..", "escaped.txt")

      const failure = await writeFailure(
        { filePath: escaped, content: "pwned" },
        { directory: session, ask: denying(log) },
      )

      expect(failure).toBeInstanceOf(ToolFailure)
      expect(failure.message).toContain("outside the session directory")
      expect(existsSync(path.join(directory, "escaped.txt"))).toBe(false)
      expect(log).toHaveLength(1)
      expect(log[0]?.permission).toBe("external_directory")
    })

    test("asks before writing to an absolute path in another directory and refuses when denied", async () => {
      const log: Request[] = []
      const target = path.join(outside, "stolen.txt")

      const failure = await writeFailure({ filePath: target, content: "pwned" }, { ask: denying(log) })

      expect(failure).toBeInstanceOf(ToolFailure)
      expect(existsSync(target)).toBe(false)
      expect(log[0]?.permission).toBe("external_directory")
    })

    test("writes outside the session directory once approved, and says that it did", async () => {
      const log: Request[] = []
      const target = path.join(outside, "approved.txt")

      const result = await write({ filePath: target, content: "ok\n" }, { ask: recording(log) })

      expect(readFileSync(target, "utf8")).toBe("ok\n")
      expect(result.output).toContain("outside the session directory")
      expect(result.metadata?.outside).toBe(true)
      expect(log).toHaveLength(1)
    })

    test("does not ask for a path that stays inside the session directory", async () => {
      const log: Request[] = []
      await write({ filePath: "inside/ok.txt", content: "x" }, { ask: recording(log) })

      expect(log).toHaveLength(0)
    })

    test("refuses a symlinked directory inside the session dir that points out of it", async () => {
      const log: Request[] = []
      symlinkSync(outside, path.join(directory, "link"))
      const target = path.join(directory, "link", "pwned.txt")

      const failure = await writeFailure({ filePath: target, content: "pwned" }, { ask: denying(log) })

      expect(failure).toBeInstanceOf(ToolFailure)
      expect(existsSync(path.join(outside, "pwned.txt"))).toBe(false)
      expect(log[0]?.permission).toBe("external_directory")
    })

    test("refuses a symlinked file inside the session dir that points out of it", async () => {
      const log: Request[] = []
      const real = path.join(outside, "real.txt")
      writeFileSync(real, "original")
      symlinkSync(real, path.join(directory, "alias.txt"))

      const failure = await writeFailure(
        { filePath: path.join(directory, "alias.txt"), content: "pwned" },
        { ask: denying(log) },
      )

      expect(failure).toBeInstanceOf(ToolFailure)
      expect(readFileSync(real, "utf8")).toBe("original")
      expect(log[0]?.permission).toBe("external_directory")
    })

    test("does not report an out-of-tree write as an ordinary in-tree create", async () => {
      const log: Request[] = []
      symlinkSync(outside, path.join(directory, "link"))

      const result = await write(
        { filePath: path.join(directory, "link", "note.txt"), content: "x" },
        { ask: recording(log) },
      )

      expect(result.title).toBe(path.join(directory, "link", "note.txt"))
      expect(result.output).toContain("outside the session directory")
      expect(readFileSync(path.join(outside, "note.txt"), "utf8")).toBe("x")
    })
  })

  describe("blank paths", () => {
    test("rejects an empty filePath instead of resolving to the session directory", async () => {
      const failure = await writeFailure({ filePath: "", content: "x" })

      expect(failure).toBeInstanceOf(ToolFailure)
      expect(failure.message).toContain("empty")
    })

    test("rejects a whitespace-only filePath instead of creating a file named with spaces", async () => {
      const failure = await writeFailure({ filePath: "   ", content: "x" })

      expect(failure).toBeInstanceOf(ToolFailure)
      expect(readdirSync(directory)).toHaveLength(0)
    })
  })

  describe("stat failures", () => {
    test("does not treat an unreadable path as absent", async () => {
      // A symlink pointing at itself: stat fails with ELOOP, which is not absence.
      const loop = path.join(directory, "loop")
      symlinkSync(loop, loop)

      const failure = await writeFailure({ filePath: loop, content: "x" })

      expect(failure).toBeInstanceOf(ToolFailure)
      expect(failure.message).toContain("Could not inspect")
      expect(failure.message).toContain("Nothing was written")
    })

    test("still treats a missing leaf under a file component as absent", async () => {
      const blocker = path.join(directory, "file")
      writeFileSync(blocker, "x")

      const failure = await writeFailure({ filePath: path.join(blocker, "child.txt"), content: "y" })

      expect(failure.message).toContain("parent directory")
      expect(failure.message).not.toContain("Could not inspect")
    })
  })

  describe("abort between awaits", () => {
    test("stops before creating the parent directory when aborted after the stat", async () => {
      const filePath = path.join(directory, "late", "file.txt")

      const failure = await writeFailure({ filePath, content: "x" }, { abort: abortOnRead(1) })

      expect(failure).toBeInstanceOf(ToolFailure)
      expect(existsSync(path.join(directory, "late"))).toBe(false)
    })

    test("stops before writing when aborted after the parent directory was created", async () => {
      const filePath = path.join(directory, "later", "file.txt")

      const failure = await writeFailure({ filePath, content: "x" }, { abort: abortOnRead(2) })

      expect(failure).toBeInstanceOf(ToolFailure)
      expect(existsSync(path.join(directory, "later"))).toBe(true)
      expect(existsSync(filePath)).toBe(false)
    })
  })
})
