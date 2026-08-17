import { messageID, sessionID } from "@compass/schema"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { PermissionDenied, type Request as PermissionRequest } from "../src/permission/permission"
import { globTool, MAX_LIMIT, SCAN_CEILING } from "../src/tool/glob"
import { decode, ToolFailure, type Context, type Result } from "../src/tool/tool"

let root = ""

/** Grants every authorization request. Tests that care about the guard override `ask`. */
const context = (directory: string): Context => ({
  sessionID: sessionID(),
  messageID: messageID(),
  callID: "call_glob",
  directory,
  abort: new AbortController().signal,
  ask: () => Effect.void,
})

/** Captures what the tool asked for without answering no. */
const recorder = () => {
  const requests: PermissionRequest[] = []
  return {
    requests,
    ask: (request: PermissionRequest) =>
      Effect.sync(() => {
        requests.push(request)
      }),
  }
}

/** Refuses every authorization request, the way a user declining the prompt would. */
const refusing = () => {
  const requests: PermissionRequest[] = []
  return {
    requests,
    ask: (request: PermissionRequest) => {
      requests.push(request)
      return new PermissionDenied({ permission: request.permission, pattern: request.patterns[0] ?? "*" })
    },
  }
}

/**
 * An AbortSignal that hands every `aborted` check to `decide`, which is given the
 * running check count and returns whether the turn is aborted by now. It lets a test
 * act at one exact point of the run instead of racing a wall-clock timer against it.
 */
const watchedSignal = (decide: (check: number) => boolean) => {
  const controller = new AbortController()
  let checks = 0
  const signal = new Proxy(controller.signal, {
    get(target, property) {
      if (property === "aborted") {
        checks += 1
        if (decide(checks)) controller.abort()
        return controller.signal.aborted
      }
      const value = Reflect.get(target, property)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
  return { signal, checks: () => checks }
}

interface Input {
  readonly pattern: string
  readonly path?: string
  readonly limit?: number
}

const run = (input: Input, directory = root, overrides: Partial<Context> = {}): Promise<Result> =>
  Effect.runPromise(globTool.execute(input, { ...context(directory), ...overrides }))

const runFailure = (input: Input, directory = root, overrides: Partial<Context> = {}): Promise<ToolFailure> =>
  Effect.runPromise(globTool.execute(input, { ...context(directory), ...overrides }).pipe(Effect.flip))

/** Explicit mtimes keep the ordering assertions deterministic on fast filesystems. */
const write = (relative: string, contents: string, minutesAgo: number) => {
  const file = path.join(root, relative)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, contents)
  const stamp = new Date(Date.now() - minutesAgo * 60_000)
  utimesSync(file, stamp, stamp)
  return file
}

/** Throwaway roots for tests whose fixtures would perturb the shared tree. */
const scratched: string[] = []

const scratch = (label: string) => {
  const directory = mkdtempSync(path.join(tmpdir(), label))
  scratched.push(directory)
  return directory
}

const seed = (directory: string, relative: string, contents = "x") => {
  const file = path.join(directory, relative)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, contents)
  return file
}

/**
 * Paths from the listing block only, so trailing notes stay out. The tool already
 * renders paths inside the session directory relative to it, so these are compared
 * as printed — a random tmpdir name can never spoof a match.
 */
const listed = (result: Result) => (result.output.split("\n\n")[0] ?? "").split("\n").toSorted()

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
  for (const directory of scratched) rmSync(directory, { recursive: true, force: true })
})

describe("globTool", () => {
  test("finds matching files and returns paths relative to the session directory", async () => {
    const result = await run({ pattern: "**/*.ts" })
    const lines = result.output.split("\n")

    expect(lines).toContain(path.join("src", "old.ts"))
    expect(lines).toContain(path.join("src", "newest.ts"))
    expect(lines).toContain(path.join("src", "nested", "middle.ts"))
    // Every match here lives inside the session directory, so none of them stay absolute.
    expect(lines.every((line) => !path.isAbsolute(line))).toBe(true)
    expect(result.output).not.toContain("notes.md")
  })

  test("sorts results by modification time, most recent first", async () => {
    const result = await run({ pattern: "src/**/*.ts" })

    expect(result.output.split("\n")).toEqual([
      path.join("src", "newest.ts"),
      path.join("src", "nested", "middle.ts"),
      path.join("src", "old.ts"),
    ])
  })

  test("ignores node_modules, dist and .git by default", async () => {
    const result = await run({ pattern: "**/*.ts" })
    // Already printed relative to root, so a random tmpdir name can never spoof a match.
    const relative = result.output.split("\n")

    expect(relative.toSorted()).toEqual([
      path.join("src", "nested", "middle.ts"),
      path.join("src", "newest.ts"),
      path.join("src", "old.ts"),
    ])
    expect(result.metadata?.matched).toBe(3)
  })

  test("searches an ignored directory when the pattern names it explicitly", async () => {
    const result = await run({ pattern: "node_modules/**/*.ts" })

    expect(result.output).toBe(path.join("node_modules", "dep", "index.ts"))
    expect(result.metadata?.matched).toBe(1)
  })

  test("keeps an ignore active when the pattern only contains its name as a substring", async () => {
    const directory = scratch("compass-glob-segment-")
    seed(directory, "dist/dist-utils/hidden.ts")
    seed(directory, "src/dist-utils/visible.ts")

    const result = await run({ pattern: "**/dist-utils/*.ts" }, directory)

    expect(listed(result)).toEqual([path.join("src", "dist-utils", "visible.ts")])
    expect(result.metadata?.matched).toBe(1)
  })

  test("keeps the .git ignore active for a pattern that merely starts with .git", async () => {
    const directory = scratch("compass-glob-dotgit-")
    seed(directory, ".git/objects/.gitkeep")
    seed(directory, "src/.gitkeep")

    const result = await run({ pattern: "**/.gitkeep" }, directory)

    expect(listed(result)).toEqual([path.join("src", ".gitkeep")])
  })

  test("caps output at the limit and reports that results were capped", async () => {
    const result = await run({ pattern: "src/**/*.ts", limit: 2 })
    const lines = result.output.split("\n")

    expect(lines[0]).toBe(path.join("src", "newest.ts"))
    expect(lines[1]).toBe(path.join("src", "nested", "middle.ts"))
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

    expect(result.output).toBe(path.join("src", "nested", "middle.ts"))
    expect(result.title).toBe(`*.ts in ${path.join("src", "nested")}`)
  })

  test("reports a partial scan as an arbitrary sample rather than the newest matches", async () => {
    const directory = scratch("compass-glob-ceiling-")
    const many = path.join(directory, "many")
    mkdirSync(many, { recursive: true })
    for (let index = 0; index <= SCAN_CEILING; index++) writeFileSync(path.join(many, `f${index}.txt`), "")

    const result = await run({ pattern: "many/*.txt", limit: 5 }, directory)

    expect(result.metadata?.partialScan).toBe(true)
    expect(result.metadata?.matched).toBe(SCAN_CEILING)
    expect(result.metadata?.count).toBe(5)
    expect(result.output.split("\n\n")[0]?.split("\n")).toHaveLength(5)
    expect(result.output).toContain("arbitrary sample")
    expect(result.output).toContain(`${SCAN_CEILING}-match ceiling`)
    // The walk stops in directory order, so claiming recency over the whole set would be a lie.
    expect(result.output).not.toContain("most recently modified of")
  })

  describe("containment", () => {
    test("asks for authorization before searching outside the session directory", async () => {
      const outside = scratch("compass-glob-outside-")
      seed(outside, "secret.conf", "token=1")
      const permission = recorder()

      const result = await run({ pattern: "*.conf", path: outside }, root, { ask: permission.ask })

      expect(result.output).toBe(path.join(outside, "secret.conf"))
      expect(permission.requests).toHaveLength(1)
      expect(permission.requests[0]?.permission).toBe("external_directory")
    })

    test("refuses to search outside the session directory when authorization is denied", async () => {
      const outside = scratch("compass-glob-denied-")
      seed(outside, "secret.conf", "token=1")
      const permission = refusing()

      const error = await runFailure({ pattern: "*.conf", path: outside }, root, { ask: permission.ask })

      expect(error).toBeInstanceOf(ToolFailure)
      expect(error.message).toContain("outside the session directory")
      expect(error.message).not.toContain("secret.conf")
      expect(permission.requests).toHaveLength(1)
    })

    test("rejects an absolute pattern instead of escaping the search root through it", async () => {
      const outside = scratch("compass-glob-abspattern-")
      seed(outside, "secret.conf", "token=1")
      const permission = recorder()

      const error = await runFailure({ pattern: path.join(outside, "*.conf") }, root, { ask: permission.ask })

      expect(error).toBeInstanceOf(ToolFailure)
      expect(error.message).toContain("must be relative")
      // Rejected before anything is listed, so nothing outside was ever enumerated.
      expect(permission.requests).toHaveLength(0)
    })

    test("rejects a pattern that walks out of the search root with ..", async () => {
      const error = await runFailure({ pattern: "../*/*.ts" })

      expect(error).toBeInstanceOf(ToolFailure)
      expect(error.message).toContain("must be relative")
    })

    test("rejects a .. hidden inside a brace alternative", async () => {
      const error = await runFailure({ pattern: "{..,src}/*.ts" })

      expect(error).toBeInstanceOf(ToolFailure)
      expect(error.message).toContain("must be relative")
    })

    test("still searches a sibling directory once it is authorized", async () => {
      const permission = recorder()

      const result = await run({ pattern: "*.ts", path: path.join(root, "src") }, path.join(root, "src/nested"), {
        ask: permission.ask,
      })

      expect(result.output.split("\n")).toEqual([path.join(root, "src/newest.ts"), path.join(root, "src/old.ts")])
      expect(permission.requests[0]?.permission).toBe("external_directory")
    })
  })

  describe("unreadable search paths", () => {
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

    test("says a path is blocked by a non-directory component, not that it is absent", async () => {
      const error = await runFailure({ pattern: "*.ts", path: "src/old.ts/nested" })

      expect(error).toBeInstanceOf(ToolFailure)
      expect(error.message).toContain("not a directory")
      expect(error.message).not.toContain("does not exist")
    })

    test("says a symlink loop is a loop, not that the path is absent", async () => {
      const directory = scratch("compass-glob-loop-")
      symlinkSync(path.join(directory, "loop-b"), path.join(directory, "loop-a"))
      symlinkSync(path.join(directory, "loop-a"), path.join(directory, "loop-b"))

      const error = await runFailure({ pattern: "*.ts", path: "loop-a" }, directory)

      expect(error).toBeInstanceOf(ToolFailure)
      expect(error.message).toContain("symlink loop")
      expect(error.message).not.toContain("does not exist")
    })

    test("rejects a blank path with advice instead of searching the filesystem root", async () => {
      const error = await runFailure({ pattern: "*.ts", path: "   " })

      expect(error).toBeInstanceOf(ToolFailure)
      expect(error.message).toContain("omit it")
    })
  })

  describe("abort", () => {
    test("stops the walk when the turn is aborted", async () => {
      const controller = new AbortController()
      controller.abort()

      const error = await runFailure({ pattern: "**/*.ts" }, root, { abort: controller.signal })

      expect(error).toBeInstanceOf(ToolFailure)
      expect(error.message).toContain("aborted before it started")
    })

    test("stops during the stat phase when the abort arrives after the walk", async () => {
      // One check on the way in, then one per walked match (src holds three), so the
      // fourth check is the last one the walk makes and the fifth belongs to statAll.
      const aborter = watchedSignal((check) => check > 4)

      const error = await runFailure({ pattern: "src/**/*.ts" }, root, { abort: aborter.signal })

      expect(error).toBeInstanceOf(ToolFailure)
      expect(error.message).toContain("aborted before it finished")
      expect(aborter.checks()).toBeGreaterThan(4)
    })
  })

  test("reports matches that disappeared between the walk and the stat", async () => {
    const directory = scratch("compass-glob-vanish-")
    seed(directory, "a.ts")
    const doomed = seed(directory, "b.ts")
    seed(directory, "c.ts")
    // The fourth check is the walk's last, so deleting here lands the file squarely
    // between the walk that found it and the stat that will look for it.
    const watcher = watchedSignal((check) => {
      if (check === 4) rmSync(doomed)
      return false
    })

    const result = await run({ pattern: "*.ts" }, directory, { abort: watcher.signal })

    expect(result.metadata?.vanished).toBe(1)
    expect(result.metadata?.matched).toBe(2)
    expect(listed(result)).toEqual(["a.ts", "c.ts"])
    expect(result.output).toContain("1 matched path disappeared")
  })

  describe("schema boundary", () => {
    test("accepts a well-formed input through the declared schema", async () => {
      const decoded = await Effect.runPromise(decode(globTool, { pattern: "**/*.ts", limit: 5 }))

      expect(decoded).toEqual({ pattern: "**/*.ts", limit: 5 })
    })

    test("rejects a limit outside the accepted range at the schema boundary", async () => {
      for (const limit of [0, -5, 1.5, MAX_LIMIT + 1]) {
        const error = await Effect.runPromise(Effect.flip(decode(globTool, { pattern: "**/*.ts", limit })))

        expect(error).toBeInstanceOf(ToolFailure)
        expect(error.message).toContain("Invalid tool input")
      }

      const accepted = await Effect.runPromise(decode(globTool, { pattern: "**/*.ts", limit: MAX_LIMIT }))
      expect(accepted).toEqual({ pattern: "**/*.ts", limit: MAX_LIMIT })
    })

    test("rejects a missing pattern at the schema boundary", async () => {
      const error = await Effect.runPromise(Effect.flip(decode(globTool, { path: "src" })))

      expect(error).toBeInstanceOf(ToolFailure)
    })
  })
})
