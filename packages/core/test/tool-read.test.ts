import { MessageID, SessionID } from "@compass/schema"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readTool } from "../src/tool/read"
import type { Context } from "../src/tool/tool"

type Input = Parameters<typeof readTool.execute>[0]

let root: string

const context = (overrides: Partial<Context> = {}): Context => ({
  sessionID: SessionID.make("ses_read_test"),
  messageID: MessageID.make("msg_read_test"),
  callID: "call_read_test",
  directory: root,
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
        "<path>" + path + "</path>",
        "<content>",
        "1: alpha",
        "2: beta",
        "3: gamma",
        "</content>",
        "",
        "(End of file - 3 lines)",
      ].join("\n"),
    )
    expect(result.metadata).toMatchObject({ lineStart: 1, lineEnd: 3, totalLines: 3, truncated: false })
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
