import { MessageID, SessionID } from "@compass/schema"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { PermissionDenied, type Request as PermissionRequest } from "../src/permission/permission"
import { readTool } from "../src/tool/read"
import { make as makeRegistry } from "../src/tool/registry"
import type { Context } from "../src/tool/tool"

type Input = Parameters<typeof readTool.execute>[0]

let root: string

const context = (overrides: Partial<Context> = {}): Context => ({
  sessionID: SessionID.make("ses_read_test"),
  messageID: MessageID.make("msg_read_test"),
  callID: "call_read_test",
  directory: root,
  ask: () => Effect.void,
  abort: new AbortController().signal,
  ...overrides,
})

const read = (input: Input, overrides?: Partial<Context>) =>
  Effect.runPromise(readTool.execute(input, context(overrides)))

const readError = (input: Input, overrides?: Partial<Context>) =>
  Effect.runPromise(readTool.execute(input, context(overrides)).pipe(Effect.flip))

const write = (name: string, content: string) => {
  const path = join(root, name)
  writeFileSync(path, content)
  return path
}

/** Records every authorization request and grants it. */
const recordingAsk = (log: PermissionRequest[]) => (request: PermissionRequest) =>
  Effect.sync(() => {
    log.push(request)
  })

const denyingAsk = (request: PermissionRequest) =>
  Effect.fail(new PermissionDenied({ permission: request.permission, pattern: request.patterns[0] ?? "*" }))

/**
 * Aborts once `aborted` has been read `allowed` times, which pins down *where*
 * the tool checks: a tool that only checks at entry never trips it.
 */
const abortAfter = (allowed: number): AbortSignal => {
  const controller = new AbortController()
  let seen = 0
  return new Proxy(controller.signal, {
    get: (target, property) => {
      if (property !== "aborted") {
        const value = Reflect.get(target, property)
        return typeof value === "function" ? value.bind(target) : value
      }
      seen += 1
      if (seen > allowed) controller.abort()
      return target.aborted
    },
  })
}

const aborted = () => {
  const controller = new AbortController()
  controller.abort()
  return controller.signal
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "compass-read-"))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("readTool", () => {
  test("numbers every line and reports the end of the file", async () => {
    const path = write("basic.txt", "alpha\nbeta\ngamma\n")
    const result = await read({ filePath: path })

    expect(result.output).toBe(
      [
        // Inside the session directory, so the header is spelled relative to it.
        "<path>basic.txt</path>",
        "<content>",
        "1: alpha",
        "2: beta",
        "3: gamma",
        "</content>",
        "",
        "(End of file - 3 lines)",
      ].join("\n"),
    )
    expect(result.metadata).toMatchObject({ totalLines: 3, requestedOffset: 0, more: false })
  })

  test("resolves a relative path against the session directory", async () => {
    mkdirSync(join(root, "nested"), { recursive: true })
    write(join("nested", "relative.txt"), "hit\n")

    const result = await read({ filePath: "nested/relative.txt" })

    expect(result.output).toContain("1: hit")
    expect(result.title).toBe(join("nested", "relative.txt"))
  })

  test("keeps a file without a trailing newline intact", async () => {
    const path = write("no-newline.txt", "first\nsecond")
    const result = await read({ filePath: path })

    expect(result.output).toContain("2: second")
    expect(result.output).toContain("(End of file - 2 lines)")
  })

  test("windows on offset and limit using real 1-based line numbers", async () => {
    const path = write("window.txt", Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n") + "\n")
    const result = await read({ filePath: path, offset: 3, limit: 2 })

    expect(result.output).toContain("4: line4")
    expect(result.output).toContain("5: line5")
    expect(result.output).not.toContain("3: line3")
    expect(result.output).not.toContain("6: line6")
    expect(result.output).toContain("(Showing lines 4-5 of 10. Use offset=5 to continue.)")
  })

  test("the advertised continuation offset resumes exactly where the window stopped", async () => {
    const path = write("continue.txt", Array.from({ length: 6 }, (_, i) => `row${i + 1}`).join("\n") + "\n")
    const first = await read({ filePath: path, offset: 0, limit: 4 })
    expect(first.output).toContain("(Showing lines 1-4 of 6. Use offset=4 to continue.)")

    const second = await read({ filePath: path, offset: 4 })
    expect(second.output).toContain("5: row5")
    expect(second.output).toContain("6: row6")
    expect(second.output).not.toContain("4: row4")
    expect(second.output).toContain("(End of file - 6 lines)")
  })

  test("defaults to 2000 lines and points at the next offset", async () => {
    const path = write("long.txt", Array.from({ length: 2500 }, (_, i) => `l${i + 1}`).join("\n") + "\n")
    const result = await read({ filePath: path })

    expect(result.output).toContain("2000: l2000")
    expect(result.output).not.toContain("2001: l2001")
    expect(result.output).toContain("(Showing lines 1-2000 of 2500. Use offset=2000 to continue.)")
  })

  test("says an empty file is empty instead of returning nothing", async () => {
    const path = write("empty.txt", "")
    const result = await read({ filePath: path })

    expect(result.output).toContain("(File is empty - 0 lines)")
    expect(result.metadata).toMatchObject({ totalLines: 0, empty: true })
  })

  test("caps a very long line and marks the cut", async () => {
    const path = write("wide.txt", `${"x".repeat(5000)}\nshort\n`)
    const result = await read({ filePath: path })

    const line = result.output.split("\n")[2] ?? ""
    expect(line.startsWith("1: " + "x".repeat(2000))).toBe(true)
    expect(line).toContain("line truncated at 2000 characters")
    expect(line).not.toContain("x".repeat(2001))
    expect(result.output).toContain("2: short")
  })

  test("strips carriage returns from CRLF files", async () => {
    const path = write("crlf.txt", "one\r\ntwo\r\n")
    const result = await read({ filePath: path })

    expect(result.output).toContain("1: one\n")
    expect(result.output).not.toContain("\r")
  })

  test("fails on a missing file and suggests similar names in the directory", async () => {
    write("configuration.json", "{}\n")
    const failure = await readError({ filePath: join(root, "config.json") })

    expect(failure.message).toContain("File not found")
    expect(failure.message).toContain("Did you mean one of these?")
    expect(failure.message).toContain("configuration.json")
  })

  test("fails plainly on a missing file with no similar names", async () => {
    const empty = mkdtempSync(join(tmpdir(), "compass-read-bare-"))
    const failure = await readError({ filePath: join(empty, "nothing-here.txt") }, { directory: empty })

    expect(failure.message).toContain("File not found")
    expect(failure.message).not.toContain("Did you mean")
    rmSync(empty, { recursive: true, force: true })
  })

  test("never leaks a stack trace in the failure message", async () => {
    const failure = await readError({ filePath: join(root, "absent.txt") })
    expect(failure.message).not.toContain("    at ")
  })

  test("refuses a directory with an actionable message", async () => {
    const path = join(root, "a-directory")
    mkdirSync(path, { recursive: true })
    const failure = await readError({ filePath: path })

    expect(failure.message).toContain("is a directory, not a file")
  })

  test("refuses a binary file detected by its contents", async () => {
    const path = join(root, "payload.data")
    writeFileSync(path, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01, 0x02, 0x00, 0x03, 0x00]))
    const failure = await readError({ filePath: path })

    expect(failure.message).toContain("binary data, not text")
  })

  test("refuses an image by extension before reading it", async () => {
    const path = write("logo.png", "not really a png but the extension decides\n")
    const failure = await readError({ filePath: path })

    expect(failure.message).toContain("is an image")
  })

  test("refuses a zero-byte image instead of calling it an empty text file", async () => {
    const path = write("blank.png", "")
    const failure = await readError({ filePath: path })

    expect(failure.message).toContain("is an image")
  })

  test("refuses a zero-byte archive instead of calling it an empty text file", async () => {
    const path = write("blank.zip", "")
    const failure = await readError({ filePath: path })

    expect(failure.message).toContain("is a binary format")
  })

  test("refuses a known binary extension", async () => {
    const path = write("bundle.zip", "pretend archive\n")
    const failure = await readError({ filePath: path })

    expect(failure.message).toContain("is a binary format")
  })

  test("fails when the offset is past the end of the file", async () => {
    const path = write("short.txt", "only\ntwo\n")
    const failure = await readError({ filePath: path, offset: 9 })

    expect(failure.message).toContain("Offset 9 is past the end")
    expect(failure.message).toContain("the file has 2 lines")
    expect(failure.message).toContain("last valid offset is 1")
  })

  test("reports an empty file as empty even when an offset was requested", async () => {
    const path = write("empty-offset.txt", "")
    const result = await read({ filePath: path, offset: 40 })

    expect(result.output).toContain("(File is empty - 0 lines)")
  })

  test("decodes multibyte characters split across stream chunks", async () => {
    // Well past Bun's read chunk size, so the decoder must stitch partial code points.
    const line = "日本語のテキスト 🚀 with emoji"
    const count = 4000
    const path = write("multibyte.txt", Array.from({ length: count }, () => line).join("\n") + "\n")

    const tail = await read({ filePath: path, offset: count - 2 })
    expect(tail.output).toContain(`${count - 1}: ${line}`)
    expect(tail.output).toContain(`${count}: ${line}`)
    expect(tail.output).toContain(`(End of file - ${count} lines)`)
    expect(tail.output).not.toContain("�")
  })

  test("reads the final line when the offset lands exactly on it", async () => {
    const path = write("boundary.txt", "a\nb\nc\n")
    const result = await read({ filePath: path, offset: 2 })

    expect(result.output).toContain("3: c")
    expect(result.output).toContain("(End of file - 3 lines)")
  })
})

describe("readTool metadata", () => {
  test("states no delivered line range, because the registry bounds output afterwards", async () => {
    const path = write("meta-window.txt", Array.from({ length: 2500 }, (_, i) => `m${i + 1}`).join("\n") + "\n")
    const result = await read({ filePath: path })

    // lineStart/lineEnd used to claim 1-2000 while middle-out bounding delivered
    // roughly half of that, so the metadata contradicted the text the model saw.
    expect(result.metadata).not.toHaveProperty("lineStart")
    expect(result.metadata).not.toHaveProperty("lineEnd")
    expect(result.metadata).toMatchObject({ totalLines: 2500, requestedOffset: 0, requestedLimit: 2000, more: true })
  })

  test("reports the window that was asked for, not one that was delivered", async () => {
    const path = write("meta-offset.txt", Array.from({ length: 10 }, (_, i) => `n${i + 1}`).join("\n") + "\n")
    const result = await read({ filePath: path, offset: 4, limit: 3 })

    expect(result.metadata).toMatchObject({ requestedOffset: 4, requestedLimit: 3, totalLines: 10, more: true })
  })
})

describe("readTool bounding", () => {
  test("the continuation footer survives registry bounding of a large file", async () => {
    const path = write("bounded.txt", Array.from({ length: 2500 }, (_, i) => `b${i + 1}`).join("\n") + "\n")
    const registry = makeRegistry([{ name: "read", tool: readTool }], { ask: () => Effect.void })

    const settled = await Effect.runPromise(
      registry.settle({
        name: "read",
        input: { filePath: path },
        context: {
          sessionID: SessionID.make("ses_read_test"),
          messageID: MessageID.make("msg_read_test"),
          callID: "call_read_test",
          directory: root,
          abort: new AbortController().signal,
        },
      }),
    )

    expect(settled.ok).toBe(true)
    if (!settled.ok) return
    // The whole point of middle-out bounding: the trailing hint is what tells the
    // model how to get the rest, so losing it strands the read.
    expect(settled.result.output).toContain("(Showing lines 1-2000 of 2500. Use offset=2000 to continue.)")
    expect(settled.result.output).toContain("truncated")
    expect(settled.result.output).toContain("1: b1")
  })
})

describe("readTool suggestions", () => {
  test("does not suggest unrelated names just because they share a letter", async () => {
    const directory = mkdtempSync(join(tmpdir(), "compass-read-noise-"))
    writeFileSync(join(directory, "a.go"), "package main\n")
    writeFileSync(join(directory, "e.md"), "# doc\n")
    writeFileSync(join(directory, "zzz.txt"), "noise\n")

    const failure = await readError({ filePath: join(directory, "read.ts") }, { directory })

    expect(failure.message).toContain("File not found")
    expect(failure.message).not.toContain("Did you mean")
    expect(failure.message).not.toContain("a.go")
    expect(failure.message).not.toContain("zzz.txt")
    rmSync(directory, { recursive: true, force: true })
  })

  test("still suggests a genuine near-miss that differs only in extension", async () => {
    const directory = mkdtempSync(join(tmpdir(), "compass-read-near-"))
    writeFileSync(join(directory, "handler.tsx"), "export {}\n")

    const failure = await readError({ filePath: join(directory, "handler.ts") }, { directory })

    expect(failure.message).toContain("Did you mean")
    expect(failure.message).toContain("handler.tsx")
    rmSync(directory, { recursive: true, force: true })
  })

  test("says how many similar names were withheld instead of dropping them silently", async () => {
    const directory = mkdtempSync(join(tmpdir(), "compass-read-many-"))
    for (const name of ["report1.md", "report2.md", "report3.md", "report4.md", "report5.md"]) {
      writeFileSync(join(directory, name), "x\n")
    }

    const failure = await readError({ filePath: join(directory, "report.md") }, { directory })

    expect(failure.message).toContain("Did you mean")
    expect(failure.message).toContain("2 further similar names not shown.")
    rmSync(directory, { recursive: true, force: true })
  })
})

describe("readTool path containment", () => {
  test("asks before reading a file outside the session directory", async () => {
    const outside = mkdtempSync(join(tmpdir(), "compass-read-outside-"))
    writeFileSync(join(outside, "secret.txt"), "classified\n")
    const log: PermissionRequest[] = []

    const result = await read({ filePath: join(outside, "secret.txt") }, { ask: recordingAsk(log) })

    expect(result.output).toContain("1: classified")
    expect(log).toHaveLength(1)
    expect(log[0]?.permission).toBe("external_directory")
    rmSync(outside, { recursive: true, force: true })
  })

  test("refuses an escaping relative path when permission is denied", async () => {
    const outside = mkdtempSync(join(tmpdir(), "compass-read-escape-"))
    writeFileSync(join(outside, "escape.txt"), "nope\n")

    const escaping = relative(root, join(outside, "escape.txt"))
    expect(escaping.startsWith("..")).toBe(true)
    const failure = await readError({ filePath: escaping }, { ask: denyingAsk })

    expect(failure.message).toContain("outside the session directory")
    rmSync(outside, { recursive: true, force: true })
  })

  test("refuses an absolute path outside the session directory when permission is denied", async () => {
    const outside = mkdtempSync(join(tmpdir(), "compass-read-denied-"))
    writeFileSync(join(outside, "denied.txt"), "nope\n")

    const failure = await readError({ filePath: join(outside, "denied.txt") }, { ask: denyingAsk })

    expect(failure.message).toContain("outside the session directory")
    expect(failure.message).not.toContain("1: nope")
    rmSync(outside, { recursive: true, force: true })
  })

  test("treats a symlink pointing out of the session directory as an escape", async () => {
    const outside = mkdtempSync(join(tmpdir(), "compass-read-symlink-"))
    const target = join(realpathSync(outside), "target.txt")
    writeFileSync(target, "linked\n")
    const link = join(root, "escape-link.txt")
    symlinkSync(target, link)

    const failure = await readError({ filePath: link }, { ask: denyingAsk })

    expect(failure.message).toContain("outside the session directory")
    rmSync(link, { force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  test("allows a symlink that stays inside the session directory without asking", async () => {
    const target = write("link-target.txt", "inside\n")
    const link = join(root, "inside-link.txt")
    symlinkSync(target, link)
    const log: PermissionRequest[] = []

    const result = await read({ filePath: link }, { ask: recordingAsk(log) })

    expect(result.output).toContain("1: inside")
    expect(log).toHaveLength(0)
    rmSync(link, { force: true })
  })

  test("refuses a blank path", async () => {
    const failure = await readError({ filePath: "   " })
    expect(failure.message).toContain("must not be empty")
  })
})

describe("readTool cancellation", () => {
  test("refuses to start once the turn is already aborted", async () => {
    const path = write("cancel-entry.txt", "one\ntwo\n")
    const failure = await readError({ filePath: path }, { abort: aborted() })

    expect(failure.message).toContain("was cancelled")
  })

  test("checks the abort signal between awaits, not only at entry", async () => {
    const path = write("cancel-mid.txt", Array.from({ length: 5000 }, (_, i) => `c${i + 1}`).join("\n") + "\n")
    // Entry check passes; the signal only trips on a later check.
    const failure = await readError({ filePath: path }, { abort: abortAfter(1) })

    expect(failure.message).toContain("was cancelled")
  })
})

describe("readTool wide lines", () => {
  test("cuts a long line by code point, never mid surrogate pair", async () => {
    // The odd leading character puts a UTF-16 cut squarely inside a surrogate pair.
    const path = write("astral.txt", `a${"🚀".repeat(2500)}\ntail\n`)
    const result = await read({ filePath: path })

    const line = result.output.split("\n")[2] ?? ""
    const content = line.slice("1: ".length).replace(/\.\.\. \(line truncated.*\)$/, "")
    expect(Array.from(content)).toHaveLength(2000)
    expect(content).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
    expect(content).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
    expect(line).toContain("line truncated at 2000 characters")
    expect(result.output).toContain("2: tail")
  })

  test("leaves a wide astral line alone when it fits the code point budget", async () => {
    // 1500 emoji is 3000 UTF-16 units: a unit-based budget would have cut it.
    const path = write("astral-fits.txt", `${"🚀".repeat(1500)}\n`)
    const result = await read({ filePath: path })

    expect(result.output).not.toContain("line truncated")
    expect(result.output).toContain("🚀".repeat(1500))
  })
})
