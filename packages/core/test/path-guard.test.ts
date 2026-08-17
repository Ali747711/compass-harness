import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { contains, displayPath } from "../src/tool/path-guard"

const temp = () => realpathSync(mkdtempSync(join(tmpdir(), "compass-guard-")))

describe("contains", () => {
  test("accepts the directory itself and anything beneath it", () => {
    const dir = temp()
    expect(contains(dir, dir)).toBe(true)
    expect(contains(dir, join(dir, "a", "b.txt"))).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  test("rejects a sibling whose name merely shares the prefix", () => {
    const dir = temp()
    expect(contains(join(dir, "project"), join(dir, "project-evil", "x.txt"))).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  /**
   * The deliberate divergence from opencode, which compares lexically. A symlink
   * inside the project pointing out of it is a real escape, and resolving costs
   * nothing here because the guard already touches the filesystem.
   */
  test("follows a symlink out of the tree and reports the escape", () => {
    const dir = temp()
    const elsewhere = temp()
    writeFileSync(join(elsewhere, "secret.txt"), "s")
    symlinkSync(elsewhere, join(dir, "link"))

    expect(contains(dir, join(dir, "link", "secret.txt"))).toBe(false)

    rmSync(dir, { recursive: true, force: true })
    rmSync(elsewhere, { recursive: true, force: true })
  })
})

describe("displayPath", () => {
  test("shows a path inside the session directory relative to it", () => {
    const dir = temp()
    expect(displayPath(dir, join(dir, "src", "index.ts"))).toBe("src/index.ts")
    rmSync(dir, { recursive: true, force: true })
  })

  test("names the session directory itself rather than returning empty", () => {
    const dir = temp()
    expect(displayPath(dir, dir)).toBe(".")
    rmSync(dir, { recursive: true, force: true })
  })

  /**
   * Staying absolute is the signal: this file is not in your project. Shortening
   * it would erase the only cue the model has.
   */
  test("leaves a path outside the session directory absolute", () => {
    const dir = temp()
    const elsewhere = temp()
    const target = join(elsewhere, "notes.txt")
    expect(displayPath(dir, target)).toBe(target)
    rmSync(dir, { recursive: true, force: true })
    rmSync(elsewhere, { recursive: true, force: true })
  })

  /**
   * `contains` compares real paths while `relative` is lexical, so a symlinked
   * session directory makes them disagree — /var vs /private/var on macOS. The
   * naive answer there is a `../../private/var/...` climb, which is longer and
   * less legible than the absolute path. Keep the absolute path.
   */
  test("keeps the absolute form when a symlink makes the relative path climb out", () => {
    const real = temp()
    const link = join(temp(), "link")
    symlinkSync(real, link)
    const target = join(real, "file.txt")

    // Same directory by identity, different by spelling.
    expect(contains(link, target)).toBe(true)
    expect(displayPath(link, target)).toBe(target)

    rmSync(real, { recursive: true, force: true })
  })
})
