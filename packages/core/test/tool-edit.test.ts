import { MessageID, SessionID } from "@compass/schema"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { editTool } from "../src/tool/edit"
import type { Context } from "../src/tool/tool"

let directory = ""

const context = (overrides: Partial<Context> = {}): Context => ({
  sessionID: SessionID.make("ses_edit_test"),
  messageID: MessageID.make("msg_edit_test"),
  callID: "call_edit_test",
  directory,
  abort: new AbortController().signal,
  ...overrides,
})

interface Params {
  readonly filePath: string
  readonly oldString: string
  readonly newString: string
  readonly replaceAll?: boolean
}

const run = (params: Params, ctx: Context = context()) => Effect.runPromise(editTool.execute(params, ctx))

const fail = (params: Params, ctx: Context = context()) =>
  Effect.runPromise(editTool.execute(params, ctx).pipe(Effect.flip)).then((error) => error.message)

const write = (name: string, content: string) => {
  const filePath = join(directory, name)
  writeFileSync(filePath, content)
  return filePath
}

const read = (name: string) => readFileSync(join(directory, name), "utf-8")

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "compass-edit-"))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe("editTool", () => {
  test("declares the edit permission and a substantial description", () => {
    expect(editTool.permission).toBe("edit")
    expect(editTool.description.length).toBeGreaterThan(400)
    expect(editTool.description).toContain("replaceAll")
  })

  test("replaces a unique occurrence and writes it to disk", async () => {
    const filePath = write("greet.ts", "export const greet = () => 'hi'\n")

    const result = await run({ filePath, oldString: "'hi'", newString: "'hello'" })

    expect(read("greet.ts")).toBe("export const greet = () => 'hello'\n")
    expect(result.title).toBe("greet.ts")
    expect(result.metadata?.["filePath"]).toBe(filePath)
  })

  test("returns a unified diff of the change", async () => {
    const filePath = write("count.ts", ["const a = 1", "const b = 2", "const c = 3"].join("\n") + "\n")

    const result = await run({ filePath, oldString: "const b = 2", newString: "const b = 22" })

    expect(result.output).toContain("@@")
    expect(result.output).toContain("-const b = 2")
    expect(result.output).toContain("+const b = 22")
    // Unchanged neighbours are shown as context, not as edits.
    expect(result.output).toContain(" const a = 1")
    expect(result.output).toContain(" const c = 3")
    expect(result.metadata?.["additions"]).toBe(1)
    expect(result.metadata?.["deletions"]).toBe(1)
  })

  test("reports separate hunks for distant changes rather than the whole file", async () => {
    const lines = Array.from({ length: 40 }, (_, index) => `line ${index}`)
    const filePath = write("long.txt", lines.join("\n") + "\n")

    await run({ filePath, oldString: "line 1\n", newString: "line one\n" })
    const result = await run({ filePath, oldString: "line 38", newString: "line thirty-eight" })

    expect(result.output).not.toContain("line 20")
    expect(result.output).toContain("+line thirty-eight")
  })

  test("replaceAll rewrites every occurrence", async () => {
    const filePath = write("rename.ts", "const total = 1\nconsole.log(total)\nexport { total }\n")

    const result = await run({ filePath, oldString: "total", newString: "sum", replaceAll: true })

    expect(read("rename.ts")).toBe("const sum = 1\nconsole.log(sum)\nexport { sum }\n")
    expect(result.metadata?.["replaceAll"]).toBe(true)
  })

  test("refuses an ambiguous match instead of guessing, and leaves the file alone", async () => {
    const original = "const total = 1\nconsole.log(total)\n"
    const filePath = write("ambiguous.ts", original)

    const message = await fail({ filePath, oldString: "total", newString: "sum" })

    expect(message).toContain("multiple matches")
    expect(read("ambiguous.ts")).toBe(original)
  })

  test("preserves the tuned not-found message verbatim", async () => {
    const filePath = write("miss.ts", "const a = 1\n")

    const message = await fail({ filePath, oldString: "const b = 2", newString: "const b = 3" })

    expect(message).toBe(
      "Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings.",
    )
    expect(read("miss.ts")).toBe("const a = 1\n")
  })

  test("rejects identical oldString and newString", async () => {
    const filePath = write("same.ts", "const a = 1\n")

    const message = await fail({ filePath, oldString: "const a = 1", newString: "const a = 1" })

    expect(message).toBe("No changes to apply: oldString and newString are identical.")
  })

  test("rejects an empty oldString and points at write", async () => {
    const filePath = write("empty.ts", "const a = 1\n")

    const message = await fail({ filePath, oldString: "", newString: "const b = 2" })

    expect(message).toContain("oldString cannot be empty")
    expect(message).toContain("write")
    expect(read("empty.ts")).toBe("const a = 1\n")
  })

  test("fails on a missing file without creating it", async () => {
    const filePath = join(directory, "nope.ts")

    const message = await fail({ filePath, oldString: "a", newString: "b" })

    expect(message).toContain("File not found")
    expect(message).toContain(filePath)
    expect(Bun.file(filePath).size).toBe(0)
  })

  test("fails when the path is a directory", async () => {
    const dirPath = join(directory, "src")
    mkdirSync(dirPath)

    const message = await fail({ filePath: dirPath, oldString: "a", newString: "b" })

    expect(message).toContain("is a directory")
  })

  test("rejects an empty filePath", async () => {
    const message = await fail({ filePath: "   ", oldString: "a", newString: "b" })

    expect(message).toContain("filePath is required")
  })

  test("resolves a relative filePath against the session directory", async () => {
    mkdirSync(join(directory, "nested"))
    write("nested/config.json", '{ "port": 3000 }\n')

    const result = await run({ filePath: "nested/config.json", oldString: "3000", newString: "4000" })

    expect(read("nested/config.json")).toBe('{ "port": 4000 }\n')
    expect(result.title).toBe("nested/config.json")
  })

  test("keeps CRLF line endings when the model sends LF text", async () => {
    const filePath = write("crlf.txt", "alpha\r\nbeta\r\ngamma\r\n")

    await run({ filePath, oldString: "alpha\nbeta", newString: "alpha\nBETA" })

    expect(read("crlf.txt")).toBe("alpha\r\nBETA\r\ngamma\r\n")
  })

  test("preserves a leading byte order mark", async () => {
    const filePath = write("bom.txt", "\u{FEFF}first\nsecond\n")

    await run({ filePath, oldString: "first", newString: "1st" })

    expect(read("bom.txt")).toBe("\u{FEFF}1st\nsecond\n")
  })

  test("matches through the indentation-flexible fallback", async () => {
    const filePath = write("indent.ts", "function go() {\n    return 1\n}\n")

    // oldString is dedented relative to the file; the ported replacers recover it.
    await run({ filePath, oldString: "return 1", newString: "return 2" })

    expect(read("indent.ts")).toBe("function go() {\n    return 2\n}\n")
  })

  test("deletes text when newString is empty", async () => {
    const filePath = write("delete.ts", "const a = 1\nconst debug = true\nconst b = 2\n")

    await run({ filePath, oldString: "const debug = true\n", newString: "" })

    expect(read("delete.ts")).toBe("const a = 1\nconst b = 2\n")
  })

  test("appends without touching earlier lines", async () => {
    const filePath = write("append.ts", "one\ntwo\n")

    const result = await run({ filePath, oldString: "two\n", newString: "two\nthree\n" })

    expect(read("append.ts")).toBe("one\ntwo\nthree\n")
    expect(result.metadata?.["additions"]).toBe(1)
    expect(result.metadata?.["deletions"]).toBe(0)
  })

  test("does not write when the call is already aborted", async () => {
    const filePath = write("aborted.ts", "const a = 1\n")
    const controller = new AbortController()
    controller.abort()

    const message = await fail(
      { filePath, oldString: "const a = 1", newString: "const a = 2" },
      context({ abort: controller.signal }),
    )

    expect(message).toContain("aborted")
    expect(read("aborted.ts")).toBe("const a = 1\n")
  })
})
