import { describe, expect, test } from "bun:test"
import {
  BlockAnchorReplacer,
  ContextAwareReplacer,
  EscapeNormalizedReplacer,
  IndentationFlexibleReplacer,
  LineTrimmedReplacer,
  MultiOccurrenceReplacer,
  replace,
  SimpleReplacer,
  TrimmedBoundaryReplacer,
  trimDiff,
  WhitespaceNormalizedReplacer,
  type Replacer,
} from "../src/tool/edit-replacers"

// These tests pin ACTUAL current behavior of the opencode port. They are the
// regression net for the strict-mode type adaptation, so every expectation here
// was captured from a real run rather than derived from the docstrings.

const yields = (replacer: Replacer, content: string, find: string) => [...replacer(content, find)]

const messageOf = (fn: () => unknown): string => {
  try {
    fn()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return "<did not throw>"
}

const IDENTICAL = "No changes to apply: oldString and newString are identical."
const EMPTY =
  "oldString cannot be empty when editing an existing file. Provide the exact text to replace, or use write for an intentional full-file replacement."
const NOT_FOUND =
  "Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings."
const MULTIPLE = "Found multiple matches for oldString. Provide more surrounding context to make the match unique."
const DISPROPORTIONATE =
  "Refusing replacement because the matched span is much larger than oldString. Re-read the file and provide the full exact oldString for the intended replacement."

describe("SimpleReplacer", () => {
  test("yields the find string unconditionally, even when absent from content", () => {
    expect(yields(SimpleReplacer, "totally unrelated", "needle")).toEqual(["needle"])
  })

  test("drives an exact replace through the pipeline", () => {
    expect(replace("const a = 1\nconst b = 2", "const b = 2", "const b = 3")).toBe("const a = 1\nconst b = 3")
  })
})

describe("LineTrimmedReplacer", () => {
  test("matches when leading whitespace differs and yields the indented original span", () => {
    expect(yields(LineTrimmedReplacer, "  hello\n  world\n", "hello\nworld")).toEqual(["  hello\n  world"])
  })

  test("yields one span per trim-equal occurrence", () => {
    expect(yields(LineTrimmedReplacer, "  a\nb\n   a\n", "a")).toEqual(["  a", "   a"])
  })

  test("is the winning strategy when only indentation differs on a multi-line find", () => {
    const content = '    const 名前 = "太郎"\n    console.log(`hello ${名前}`)'
    const find = 'const 名前 = "太郎"\nconsole.log(`hello ${名前}`)'
    expect(content.indexOf(find)).toBe(-1)
    expect(replace(content, find, "REPLACED")).toBe("REPLACED")
  })
})

describe("BlockAnchorReplacer", () => {
  const content = "function foo() {\n  const a = 1\n  return a\n}"

  test("anchors on first+last line and tolerates a fuzzy middle", () => {
    const find = "function foo() {\n  const b = 2\n  return a\n}"
    expect(yields(LineTrimmedReplacer, content, find)).toEqual([])
    expect(yields(BlockAnchorReplacer, content, find)).toEqual([content])
  })

  test("requires at least three search lines", () => {
    expect(yields(BlockAnchorReplacer, "a\nb\nc", "a\nc")).toEqual([])
  })

  test("rejects a single candidate below the 0.65 similarity threshold", () => {
    expect(yields(BlockAnchorReplacer, "BEGIN\nqqqqqqqqqq\nEND", "BEGIN\nzzzzzzzzzz\nEND")).toEqual([])
    expect(messageOf(() => replace("BEGIN\nqqqqqqqqqq\nEND", "BEGIN\nzzzzzzzzzz\nEND", "X"))).toBe(NOT_FOUND)
  })

  test("picks the most similar block when several candidates share both anchors", () => {
    const twoBlocks = ["if (x) {", "  aaa()", "  bbb()", "}", "if (x) {", "  ccc()", "  ddd()", "}"].join("\n")
    const find = ["if (x) {", "  ccc()", "  dddd()", "}"].join("\n")
    expect(yields(LineTrimmedReplacer, twoBlocks, find)).toEqual([])
    expect(yields(BlockAnchorReplacer, twoBlocks, find)).toEqual(["if (x) {\n  ccc()\n  ddd()\n}"])
    expect(replace(twoBlocks, find, "if (x) {\n  eee()\n}")).toBe("if (x) {\n  aaa()\n  bbb()\n}\nif (x) {\n  eee()\n}")
  })

  test("compares levenshtein over UTF-16 units so emoji middles still match", () => {
    const emoji = ["start {", "  emit('🎉')", "}"].join("\n")
    expect(yields(BlockAnchorReplacer, emoji, ["start {", "  emit('🎊')", "}"].join("\n"))).toEqual([emoji])
  })

  // The `searchLines.length < 3` guard runs BEFORE the trailing-empty-line pop, so a
  // 2-line find ending in a newline reaches the anchor logic with searchBlockSize 2 and
  // zero middle lines to check, which hard-codes similarity to 1.0.
  test("accepts on anchors alone when a trailing newline leaves no middle lines", () => {
    const gap = "foo\nCOMPLETELY UNRELATED\nbar"
    expect(yields(LineTrimmedReplacer, gap, "foo\nbar\n")).toEqual([])
    expect(yields(BlockAnchorReplacer, gap, "foo\nbar\n")).toEqual([gap])
    expect(replace(gap, "foo\nbar\n", "REPLACED")).toBe("REPLACED")
  })
})

describe("WhitespaceNormalizedReplacer", () => {
  test("matches a whole line whose internal whitespace runs differ", () => {
    expect(yields(WhitespaceNormalizedReplacer, "const   x =   1", "const x = 1")).toEqual(["const   x =   1"])
  })

  test("falls back to a \\s+ regex to locate the matching substring inside a line", () => {
    expect(yields(WhitespaceNormalizedReplacer, "  foo(  a,   b )  more", "foo( a, b )")).toEqual(["foo(  a,   b )"])
  })

  test("matches a multi-line block after collapsing whitespace", () => {
    const content = "foo(\n      a,\n      b)"
    expect(yields(WhitespaceNormalizedReplacer, content, "foo(\n  a,\n  b)")).toEqual([content])
  })

  test("is the winning strategy for a single line with collapsed whitespace", () => {
    expect(yields(LineTrimmedReplacer, "const   x =   1", "const x = 1")).toEqual([])
    expect(replace("const   x =   1", "const x = 1", "const x = 2")).toBe("const x = 2")
  })
})

describe("IndentationFlexibleReplacer", () => {
  const content = "start\n    if (x) {\n      doThing()\n    }\nend"

  test("matches a block whose uniform indentation differs but relative indentation matches", () => {
    expect(yields(IndentationFlexibleReplacer, content, "if (x) {\n  doThing()\n}")).toEqual([
      "    if (x) {\n      doThing()\n    }",
    ])
  })

  test("refuses when relative indentation inside the block differs", () => {
    expect(yields(IndentationFlexibleReplacer, content, "if (x) {\n      doThing()\n}")).toEqual([])
  })
})

describe("EscapeNormalizedReplacer", () => {
  test("unescapes literal \\n in the find string and matches real newlines", () => {
    // Yielded twice: once from the direct unescaped match, once from the block scan.
    expect(yields(EscapeNormalizedReplacer, "line1\nline2", "line1\\nline2")).toEqual(["line1\nline2", "line1\nline2"])
    expect(replace("line1\nline2", "line1\\nline2", "ONE")).toBe("ONE")
  })

  test("matches content holding an escape sequence against a find holding the real character", () => {
    const content = "let s = 'a\\tb'"
    const find = "let s = 'a\tb'"
    expect(content.indexOf(find)).toBe(-1)
    expect(yields(EscapeNormalizedReplacer, content, find)).toEqual([content])
    expect(replace(content, find, "let s = 'ab'")).toBe("let s = 'ab'")
  })

  test("a three-line unescape survives the disproportionate-match guard", () => {
    expect(replace("a\nb\nc", "a\\nb\\nc", "Z")).toBe("Z")
  })
})

describe("TrimmedBoundaryReplacer", () => {
  test("does nothing when the find string is already trimmed", () => {
    expect(yields(TrimmedBoundaryReplacer, "alpha", "alpha")).toEqual([])
  })

  test("strips surrounding blank lines and matches the trimmed core", () => {
    expect(yields(TrimmedBoundaryReplacer, "alpha\nbeta", "\nalpha\nbeta\n")).toEqual(["alpha\nbeta"])
  })

  test("is the winning strategy when padding lines push every earlier replacer out of range", () => {
    const content = "alpha\nbeta"
    const find = "\nalpha\nbeta\n"
    for (const earlier of [
      LineTrimmedReplacer,
      BlockAnchorReplacer,
      WhitespaceNormalizedReplacer,
      IndentationFlexibleReplacer,
      EscapeNormalizedReplacer,
    ]) {
      expect(yields(earlier, content, find)).toEqual([])
    }
    expect(replace(content, find, "GAMMA")).toBe("GAMMA")
  })
})

describe("ContextAwareReplacer", () => {
  const content = ["function calc() {", "  const a = 1", "  const b = 2", "  12345678", "  87654321", "}"].join("\n")
  const find = ["function calc() {", "  const a = 1", "  const b = 2", "  zzzzzzzz", "  yyyyyyyy", "}"].join("\n")

  test("accepts a same-length block when at least half the middle lines match exactly", () => {
    expect(yields(ContextAwareReplacer, content, find)).toEqual([content])
  })

  test("is the winning strategy when BlockAnchor's char similarity falls short of 0.65", () => {
    for (const earlier of [
      LineTrimmedReplacer,
      BlockAnchorReplacer,
      WhitespaceNormalizedReplacer,
      IndentationFlexibleReplacer,
      EscapeNormalizedReplacer,
      TrimmedBoundaryReplacer,
    ]) {
      expect(yields(earlier, content, find)).toEqual([])
    }
    expect(replace(content, find, "function calc() {\n  return 3\n}")).toBe("function calc() {\n  return 3\n}")
  })

  test("rejects when fewer than half the middle lines match", () => {
    const anchored = ["HEAD", "1111", "2222", "3333", "4444", "TAIL"].join("\n")
    expect(yields(ContextAwareReplacer, anchored, ["HEAD", "1111", "wwww", "xxxx", "yyyy", "TAIL"].join("\n"))).toEqual(
      [],
    )
  })

  test("requires at least three find lines and an exact block-length match", () => {
    expect(yields(ContextAwareReplacer, "a\nb", "a\nb")).toEqual([])
    expect(yields(ContextAwareReplacer, "HEAD\n1\n2\nTAIL", "HEAD\n1\nTAIL")).toEqual([])
  })
})

describe("MultiOccurrenceReplacer", () => {
  test("yields the find string once per occurrence", () => {
    expect(yields(MultiOccurrenceReplacer, "a b a b a", "a")).toEqual(["a", "a", "a"])
  })

  test("advances past each match so overlaps are not double counted", () => {
    expect(yields(MultiOccurrenceReplacer, "aaaa", "aa")).toEqual(["aa", "aa"])
  })

  test("yields nothing when the find string is absent", () => {
    expect(yields(MultiOccurrenceReplacer, "abc", "zzz")).toEqual([])
  })
})

describe("replace throw paths", () => {
  test("identical oldString and newString", () => {
    expect(messageOf(() => replace("abc", "x", "x"))).toBe(IDENTICAL)
  })

  test("empty oldString", () => {
    expect(messageOf(() => replace("abc", "", "y"))).toBe(EMPTY)
  })

  test("the identical check runs before the empty check when both strings are empty", () => {
    expect(messageOf(() => replace("abc", "", ""))).toBe(IDENTICAL)
  })

  test("no replacer produces a match", () => {
    expect(messageOf(() => replace("abc", "zzz", "y"))).toBe(NOT_FOUND)
    expect(messageOf(() => replace("", "a", "b"))).toBe(NOT_FOUND)
  })

  test("ambiguous matches", () => {
    expect(messageOf(() => replace("foo\nfoo", "foo", "bar"))).toBe(MULTIPLE)
  })

  test("a whitespace-only oldString matches everywhere and reports ambiguity", () => {
    expect(messageOf(() => replace("a b", "   ", "X"))).toBe(MULTIPLE)
  })

  test("disproportionate match: BlockAnchor swallows a 600-char line the find never mentioned", () => {
    const content = ["START", "mid", "x".repeat(600), "END"].join("\n")
    expect(yields(BlockAnchorReplacer, content, "START\nmid\nEND")).toEqual([content])
    expect(messageOf(() => replace(content, "START\nmid\nEND", "REPLACED"))).toBe(DISPROPORTIONATE)
  })

  test("the disproportionate guard runs before the replaceAll branch", () => {
    const content = ["START", "mid", "x".repeat(600), "END"].join("\n")
    expect(messageOf(() => replace(content, "START\nmid\nEND", "R", true))).toBe(DISPROPORTIONATE)
  })

  // Line-count clause: a 1-line oldString matched to a >=4-line span is always refused,
  // which makes EscapeNormalizedReplacer unusable for four-or-more-line unescapes.
  test("disproportionate match: a single-line escaped find that unescapes to four lines", () => {
    expect(messageOf(() => replace("a\nb\nc\nd", "a\\nb\\nc\\nd", "Z"))).toBe(DISPROPORTIONATE)
  })
})

describe("replace options and encodings", () => {
  test("replaceAll rewrites every occurrence", () => {
    expect(replace("a\nfoo\nb\nfoo\nc", "foo", "bar", true)).toBe("a\nbar\nb\nbar\nc")
  })

  test("an empty newString deletes the matched span", () => {
    expect(replace("a\nremove me\nb", "remove me\n", "")).toBe("a\nb")
  })

  test("CRLF content replaces exactly without disturbing the line endings", () => {
    expect(replace("line1\r\nline2\r\nline3", "line2", "LINE2")).toBe("line1\r\nLINE2\r\nline3")
  })

  test("CRLF content with replaceAll preserves every carriage return", () => {
    expect(replace("x\r\ny\r\nx\r\ny", "x", "z", true)).toBe("z\r\ny\r\nz\r\ny")
  })

  // LineTrimmedReplacer splits on "\n" only, so the trailing "\r" of the final matched
  // line lands inside the yielded span and is consumed by the replacement.
  test("an LF-only find against CRLF content swallows the trailing carriage return", () => {
    expect(yields(LineTrimmedReplacer, "a\r\nb\r\nc", "a\nb")).toEqual(["a\r\nb\r"])
    expect(replace("a\r\nb\r\nc", "a\nb", "X")).toBe("X\nc")
  })

  test("CRLF content still fails when BlockAnchor's middle similarity is too low", () => {
    expect(messageOf(() => replace("A\r\nmid\r\nB", "A\nmiddle\nB", "GONE"))).toBe(NOT_FOUND)
  })

  test("unicode content replaces exactly", () => {
    expect(
      replace('const 挨拶 = "こんにちは"\nconsole.log(挨拶)', 'const 挨拶 = "こんにちは"', 'const 挨拶 = "さようなら"'),
    ).toBe('const 挨拶 = "さようなら"\nconsole.log(挨拶)')
  })

  test("unicode content survives a surrounding-indentation exact substring match", () => {
    expect(replace('  const emoji = "🎉"\n', 'const emoji = "🎉"', 'const emoji = "🎊"')).toBe('  const emoji = "🎊"\n')
  })
})

describe("trimDiff", () => {
  test("removes the common indentation shared by every diff content line", () => {
    const diff = ["@@ -1,3 +1,3 @@", "     const a = 1", "-    const b = 2", "+    const b = 3", "     return a"].join(
      "\n",
    )
    expect(trimDiff(diff)).toBe("@@ -1,3 +1,3 @@\n const a = 1\n-const b = 2\n+const b = 3\n return a")
  })

  test("leaves --- and +++ file headers untouched", () => {
    const diff = ["--- a/file.ts", "+++ b/file.ts", "@@ -1,2 +1,2 @@", "  ctx", "- old", "+ new"].join("\n")
    expect(trimDiff(diff)).toBe("--- a/file.ts\n+++ b/file.ts\n@@ -1,2 +1,2 @@\n ctx\n-old\n+new")
  })

  test("uses the minimum indentation across mixed depths", () => {
    expect(trimDiff(["      deep", "-    four", "+  two"].join("\n"))).toBe("    deep\n-  four\n+two")
  })

  test("returns the diff unchanged when the common indentation is zero", () => {
    expect(trimDiff("+a\n-b\n c")).toBe("+a\n-b\n c")
  })

  test("returns the diff unchanged when there are no content lines", () => {
    expect(trimDiff("no diff content here")).toBe("no diff content here")
    expect(trimDiff("")).toBe("")
  })

  test("returns the diff unchanged when every content line is blank", () => {
    expect(trimDiff("+   \n-  ")).toBe("+   \n-  ")
  })
})
