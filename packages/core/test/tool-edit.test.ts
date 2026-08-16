import { MessageID, SessionID } from "@compass/schema"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PermissionDenied, type Request as PermissionRequest } from "../src/permission/permission"
import { editTool } from "../src/tool/edit"
import type { Context } from "../src/tool/tool"

let directory = ""

const context = (overrides: Partial<Context> = {}): Context => ({
  sessionID: SessionID.make("ses_edit_test"),
  messageID: MessageID.make("msg_edit_test"),
  callID: "call_edit_test",
  directory,
  ask: () => Effect.void,
  abort: new AbortController().signal,
  ...overrides,
})

/** A context whose permission answers are recorded, so a tool's asking can be asserted. */
const recording = (
  log: PermissionRequest[],
  answer: (request: PermissionRequest) => Effect.Effect<void, PermissionDenied>,
) =>
  context({
    ask: (request) =>
      Effect.suspend(() => {
        log.push(request)
        return answer(request)
      }),
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

  // Named for what it actually covers: "return 1" is a literal substring of the
  // indented line, so SimpleReplacer wins and no fallback is involved.
  test("matches an exact substring inside an indented line", async () => {
    const filePath = write("indent.ts", "function go() {\n    return 1\n}\n")

    await run({ filePath, oldString: "return 1", newString: "return 2" })

    expect(read("indent.ts")).toBe("function go() {\n    return 2\n}\n")
  })

  test("falls back to a tolerant replacer when the model's indentation does not match the file", async () => {
    const filePath = write("indent-fallback.ts", "function go() {\n    return 1\n}\n")

    // Dedented, so it is not a substring of the file: an exact match cannot succeed
    // and only a fallback replacer can find this span.
    await run({
      filePath,
      oldString: "function go() {\nreturn 1\n}",
      newString: "function go() {\n    return 2\n}",
    })

    expect(read("indent-fallback.ts")).toBe("function go() {\n    return 2\n}\n")
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

  test("reports the loss of a trailing newline instead of calling the write a no-op", async () => {
    const filePath = write("eof-drop.txt", "alpha\nbeta\n")

    const result = await run({ filePath, oldString: "beta\n", newString: "beta" })

    expect(read("eof-drop.txt")).toBe("alpha\nbeta")
    expect(result.output).toContain("No newline at end of file")
    expect(result.metadata?.["changed"]).toBe(true)
    expect(result.metadata?.["additions"]).toBe(1)
  })

  test("reports a newly added trailing newline", async () => {
    const filePath = write("eof-add.txt", "alpha\nbeta")

    const result = await run({ filePath, oldString: "beta", newString: "beta\n" })

    expect(read("eof-add.txt")).toBe("alpha\nbeta\n")
    expect(result.output).toContain("No newline at end of file")
    expect(result.metadata?.["deletions"]).toBe(1)
  })

  test("reports a replacement that changes no bytes as no change, and leaves the file alone", async () => {
    // The whitespace-normalizing replacer matches "foo   bar" for "foo bar", and
    // substituting newString there reproduces the original bytes exactly.
    const filePath = write("noop.txt", "foo   bar\n")

    const result = await run({ filePath, oldString: "foo bar", newString: "foo   bar" })

    expect(read("noop.txt")).toBe("foo   bar\n")
    expect(result.output).toContain("No change")
    expect(result.metadata?.["changed"]).toBe(false)
    expect(result.metadata?.["additions"]).toBe(0)
    expect(result.metadata?.["deletions"]).toBe(0)
  })

  test("does not stack a second byte order mark when newString reintroduces one", async () => {
    const filePath = write("bom-again.txt", "\u{FEFF}first\nsecond\n")

    await run({ filePath, oldString: "first", newString: "\u{FEFF}1st" })

    expect(read("bom-again.txt")).toBe("\u{FEFF}1st\nsecond\n")
  })

  test("asks for the external_directory permission before editing outside the session", async () => {
    const outside = mkdtempSync(join(tmpdir(), "compass-edit-outside-"))
    const filePath = join(outside, "external.txt")
    writeFileSync(filePath, "secret\n")
    const asked: PermissionRequest[] = []

    await run(
      { filePath, oldString: "secret", newString: "public" },
      recording(asked, () => Effect.void),
    )

    expect(asked.map((request) => request.permission)).toContain("external_directory")
    expect(readFileSync(filePath, "utf-8")).toBe("public\n")
    rmSync(outside, { recursive: true, force: true })
  })

  test("does not touch a file outside the session directory when permission is refused", async () => {
    const outside = mkdtempSync(join(tmpdir(), "compass-edit-denied-"))
    const filePath = join(outside, "external.txt")
    writeFileSync(filePath, "secret\n")
    const asked: PermissionRequest[] = []
    const deny = (request: PermissionRequest) =>
      new PermissionDenied({ permission: request.permission, pattern: request.patterns[0] ?? "*" })

    const message = await fail({ filePath, oldString: "secret", newString: "public" }, recording(asked, deny))

    expect(asked).toHaveLength(1)
    expect(message).toContain("outside the session directory")
    expect(readFileSync(filePath, "utf-8")).toBe("secret\n")
    rmSync(outside, { recursive: true, force: true })
  })

  test("never asks for permission for a file inside the session directory", async () => {
    const filePath = write("inside.txt", "a\n")
    const asked: PermissionRequest[] = []

    await run(
      { filePath, oldString: "a", newString: "b" },
      recording(asked, () => Effect.void),
    )

    expect(asked).toEqual([])
  })

  test("serializes concurrent edits to one file instead of dropping one", async () => {
    const filePath = write("concurrent.txt", "one\n")

    await Promise.all([
      run({ filePath, oldString: "one\n", newString: "one\ntwo\n" }),
      run({ filePath, oldString: "one\n", newString: "one\nthree\n" }),
    ])

    const content = read("concurrent.txt")
    expect(content).toContain("two")
    expect(content).toContain("three")
  })

  test("keeps the file mode and leaves no temporary files behind", async () => {
    const filePath = write("mode.txt", "a\n")
    chmodSync(filePath, 0o640)

    await run({ filePath, oldString: "a", newString: "b" })

    expect(read("mode.txt")).toBe("b\n")
    expect(statSync(filePath).mode & 0o777).toBe(0o640)
    expect(readdirSync(directory)).toEqual(["mode.txt"])
  })

  test("edits a symlink's target rather than replacing the link", async () => {
    write("target.txt", "a\n")
    const link = join(directory, "link.txt")
    symlinkSync(join(directory, "target.txt"), link)

    await run({ filePath: link, oldString: "a", newString: "b" })

    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(read("target.txt")).toBe("b\n")
  })

  test.skipIf(process.getuid?.() === 0)("refuses to overwrite a read-only file", async () => {
    const filePath = write("readonly.txt", "a\n")
    chmodSync(filePath, 0o444)

    const message = await fail({ filePath, oldString: "a", newString: "b" })

    expect(message).toContain("not writable")
    expect(read("readonly.txt")).toBe("a\n")
  })
})
