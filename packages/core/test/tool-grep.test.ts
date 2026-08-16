import { messageID, sessionID } from "@compass/schema"
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect, Result } from "effect"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PermissionDenied, type Request as PermissionRequest } from "../src/permission/permission"
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

/** A dependency inside node_modules: skipped by default, reachable when named. */
const withDependency = (root: string) => {
  mkdirSync(join(root, "node_modules", "dep"), { recursive: true })
  const file = join(root, "node_modules", "dep", "index.js")
  writeFileSync(file, "// TODO: dep\n")
  return file
}

type Ask = Context["ask"]

const context = (directory: string, signal?: AbortSignal, ask?: Ask): Context => ({
  sessionID: sessionID(),
  messageID: messageID(),
  callID: "call_grep",
  directory,
  abort: signal ?? new AbortController().signal,
  ask: ask ?? (() => Effect.void),
})

interface Input {
  readonly pattern: string
  readonly path?: string
  readonly include?: string
  readonly limit?: number
}

const settle = (input: Input, directory: string, signal?: AbortSignal, ask?: Ask) =>
  Effect.runPromise(grepTool.execute(input, context(directory, signal, ask)).pipe(Effect.result))

const succeed = async (input: Input, directory: string, ask?: Ask) => {
  const result = await settle(input, directory, undefined, ask)
  if (Result.isFailure(result)) throw new Error(`expected success, got: ${result.failure.message}`)
  return result.success
}

const fail = async (input: Input, directory: string, signal?: AbortSignal, ask?: Ask) => {
  const result = await settle(input, directory, signal, ask)
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
// chmod 000 does not stop root, so the unreadable-file expectations only hold for a normal user.
const privileged = process.getuid?.() === 0

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

    test("treats an empty path as the session directory", async () => {
      const result = await succeed({ pattern: "TODO", path: "" }, fixture())
      expect(result.metadata?.["matches"]).toBe(3)
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
      expect(result.metadata?.["incomplete"]).toBe(false)
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

    test("marks a long matched line with what it cut", async () => {
      const root = fixture()
      writeFileSync(join(root, "wide.txt"), `TODO_CLIP ${"a".repeat(3000)}\n`)
      const result = await succeed({ pattern: "TODO_CLIP" }, root)

      expect(result.metadata?.["matches"]).toBe(1)
      expect(result.output).toContain("(line truncated at 2000 of 3010 characters)")
    })

    // Regression: the ripgrep engine dropped any JSON record over 64 KB, so a match on a
    // minified line reported as "No matches found" — absence invented out of dropped data.
    test("reports a match on a line too long to display instead of dropping it", async () => {
      const root = fixture()
      writeFileSync(join(root, "minified.js"), `${"x".repeat(100_000)}NEEDLE_LONG${"y".repeat(100_000)}\n`)
      const result = await succeed({ pattern: "NEEDLE_LONG" }, root)

      expect(result.metadata?.["matches"]).toBe(1)
      expect(result.output).not.toContain("No matches found")
      expect(result.output).toContain(
        `${join(root, "minified.js")}:1:(match omitted: line too long to display; use read to inspect this file)`,
      )
    })

    // Regression: the fallback read every file inside one Effect.tryPromise, so the first
    // EACCES aborted the whole search; ripgrep hid the same files behind --no-messages.
    test.skipIf(privileged)("keeps searching past an unreadable file and names it", async () => {
      const root = fixture()
      const secret = join(root, "secret.txt")
      writeFileSync(secret, "TODO: secret\n")
      chmodSync(secret, 0o000)

      const result = await succeed({ pattern: "TODO" }, root)
      chmodSync(secret, 0o644)

      expect(result.metadata?.["matches"]).toBe(3)
      expect(result.metadata?.["incomplete"]).toBe(true)
      expect(result.output).toContain("secret.txt")
      expect(result.output.toLowerCase()).toMatch(/could not be (read|searched)/)
    })

    // Regression: only the fallback skipped node_modules, so the engines disagreed.
    test("skips node_modules by default in both engines", async () => {
      const root = fixture()
      withDependency(root)
      const result = await succeed({ pattern: "TODO" }, root)

      expect(result.metadata?.["matches"]).toBe(3)
      expect(result.output).not.toContain("node_modules")
    })

    // Regression: the fallback's skip list was unconditional, so an include glob that
    // named node_modules explicitly could never match anything.
    test("searches a skipped directory when the include glob names it", async () => {
      const root = fixture()
      const dependency = withDependency(root)
      const result = await succeed({ pattern: "TODO", include: "node_modules/**/*.js" }, root)

      expect(result.metadata?.["matches"]).toBe(1)
      expect(result.output).toContain(`${dependency}:1:// TODO: dep`)
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

// The 10 MB ceiling only exists in the built-in walk, which reads whole files.
describe("grepTool (fallback file ceiling)", () => {
  beforeEach(() => {
    process.env["PATH"] = ""
  })
  afterEach(() => {
    process.env["PATH"] = originalPath
  })

  test("reports the files it was too large to search", async () => {
    const root = fixture()
    writeFileSync(
      join(root, "huge.log"),
      Buffer.concat([Buffer.alloc(11 * 1024 * 1024, 0x61), Buffer.from("\nTODO: huge\n", "utf8")]),
    )
    const result = await succeed({ pattern: "TODO" }, root)

    expect(result.metadata?.["matches"]).toBe(3)
    expect(result.metadata?.["incomplete"]).toBe(true)
    expect(result.output).toContain("huge.log")
    expect(result.output).toContain("10 MB")
  })

  test("does not report absence when everything it would have searched was skipped", async () => {
    const root = mkdtempSync(join(tmpdir(), "compass-grep-"))
    roots.push(root)
    writeFileSync(
      join(root, "huge.log"),
      Buffer.concat([Buffer.alloc(11 * 1024 * 1024, 0x61), Buffer.from("\nTODO: huge\n", "utf8")]),
    )
    const result = await succeed({ pattern: "TODO" }, root)

    expect(result.metadata?.["matches"]).toBe(0)
    expect(result.metadata?.["incomplete"]).toBe(true)
    expect(result.output).toContain("the search was incomplete")
    expect(result.output).toContain("huge.log")
  })
})

describe("grepTool permission", () => {
  test("asks for external_directory before searching outside the session directory", async () => {
    const session = fixture()
    const outside = fixture()
    const asked: PermissionRequest[] = []

    const result = await succeed({ pattern: "TODO: alpha", path: outside }, session, (request) =>
      Effect.sync(() => {
        asked.push(request)
      }),
    )

    expect(asked.map((request) => request.permission)).toEqual(["external_directory"])
    expect(result.output).toContain(join(outside, "alpha.ts"))
  })

  test("does not ask when the search stays inside the session directory", async () => {
    const session = fixture()
    const asked: PermissionRequest[] = []

    await succeed({ pattern: "TODO" }, session, (request) =>
      Effect.sync(() => {
        asked.push(request)
      }),
    )

    expect(asked).toEqual([])
  })

  test("fails without searching when the external directory is refused", async () => {
    const session = fixture()
    const outside = fixture()

    const error = await fail(
      { pattern: "TODO", path: outside },
      session,
      undefined,
      () => new PermissionDenied({ permission: "external_directory", pattern: outside }),
    )

    expect(error._tag).toBe("ToolFailure")
    expect(error.message).toContain("outside the session directory")
    expect(error.message).toContain(outside)
  })
})

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
