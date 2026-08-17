import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discover, render } from "../src/instruction/instruction"

let root: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "compass-instr-")))
  // The personal file lives under the real home directory, which these tests
  // must not touch — so they assert on project files and treat any global one
  // as noise to be filtered out by path.
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

const put = (dir: string, name: string, content: string) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), content)
}

/** Only the files under this test's temp root; anything else is the real home. */
const projectOnly = (files: readonly { path: string; content: string }[]) =>
  files.filter((file) => file.path.startsWith(root))

describe("discover", () => {
  test("finds the project's AGENTS.md", () => {
    put(root, "AGENTS.md", "use tabs")
    const files = projectOnly(discover({ directory: root, project: root }))
    expect(files.map((f) => f.content)).toEqual(["use tabs"])
  })

  /**
   * A package's file refines the root's rather than replacing it, so both are
   * read — root-most first, since the nearer file is the more specific and
   * should be able to override.
   */
  test("collects every ancestor, general rules first", () => {
    put(root, "AGENTS.md", "repo-wide rule")
    const nested = join(root, "packages", "api")
    put(nested, "AGENTS.md", "api-specific rule")

    const files = projectOnly(discover({ directory: nested, project: root }))
    expect(files.map((f) => f.content)).toEqual(["repo-wide rule", "api-specific rule"])
  })

  /**
   * opencode's rule, copied deliberately. A repo carrying both means one of
   * them, not a concatenation — stacking produces contradictory instructions
   * the model then has to arbitrate between.
   */
  test("AGENTS.md wins outright over CLAUDE.md", () => {
    put(root, "AGENTS.md", "the agents one")
    put(root, "CLAUDE.md", "the claude one")

    const files = projectOnly(discover({ directory: root, project: root }))
    expect(files.map((f) => f.content)).toEqual(["the agents one"])
  })

  test("falls back to CLAUDE.md when there is no AGENTS.md anywhere", () => {
    put(root, "CLAUDE.md", "the claude one")
    const files = projectOnly(discover({ directory: root, project: root }))
    expect(files.map((f) => f.content)).toEqual(["the claude one"])
  })

  /** Precedence is decided across the whole tree, not per directory. */
  test("an ancestor's AGENTS.md still beats a nearer CLAUDE.md", () => {
    put(root, "AGENTS.md", "ancestor agents")
    const nested = join(root, "packages", "api")
    put(nested, "CLAUDE.md", "nested claude")

    const files = projectOnly(discover({ directory: nested, project: root }))
    expect(files.map((f) => f.content)).toEqual(["ancestor agents"])
  })

  test("stops at the project root rather than walking to /", () => {
    // A file above the project must not be read — it belongs to something else.
    const outer = join(root, "outer")
    const project = join(outer, "project")
    put(outer, "AGENTS.md", "not ours")
    put(project, "AGENTS.md", "ours")

    const files = projectOnly(discover({ directory: project, project }))
    expect(files.map((f) => f.content)).toEqual(["ours"])
  })

  test("reports nothing when the project has no instruction file", () => {
    mkdirSync(join(root, "empty"), { recursive: true })
    expect(projectOnly(discover({ directory: join(root, "empty"), project: root }))).toEqual([])
  })

  test("ignores an empty file rather than emitting a blank section", () => {
    put(root, "AGENTS.md", "   \n\n  ")
    expect(projectOnly(discover({ directory: root, project: root }))).toEqual([])
  })

  test("skips the project walk when the directory is outside the project", () => {
    put(root, "AGENTS.md", "should not be read")
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "compass-other-")))
    const files = projectOnly(discover({ directory: elsewhere, project: root }))
    expect(files).toEqual([])
    rmSync(elsewhere, { recursive: true, force: true })
  })

  test("honours COMPASS_NO_PROJECT_INSTRUCTIONS", () => {
    put(root, "AGENTS.md", "untrusted repo rules")
    process.env["COMPASS_NO_PROJECT_INSTRUCTIONS"] = "1"
    try {
      expect(projectOnly(discover({ directory: root, project: root }))).toEqual([])
    } finally {
      delete process.env["COMPASS_NO_PROJECT_INSTRUCTIONS"]
    }
  })
})

describe("render", () => {
  test("labels each file with its path so a rule is attributable", () => {
    const output = render([
      { path: "/repo/AGENTS.md", content: "use tabs" },
      { path: "/repo/api/AGENTS.md", content: "and semicolons" },
    ])
    expect(output).toBe(
      "Instructions from: /repo/AGENTS.md\nuse tabs\n\nInstructions from: /repo/api/AGENTS.md\nand semicolons",
    )
  })

  test("renders nothing for no files, so the system prompt is left alone", () => {
    expect(render([])).toBe("")
  })
})
