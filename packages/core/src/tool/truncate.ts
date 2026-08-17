// Ported from opencode (MIT). Source: packages/core/src/tool-output-store.ts:50-110
// https://github.com/anomalyco/opencode — see licenses/opencode-MIT.txt
//
// Reduced to pure functions: opencode also writes the complete text to a managed
// file under a retention directory and names that path in the marker. That needs
// a tool-output store, which lands with the Location-scoped services.
//
// This replaces an earlier adaptation of opencode's V1 truncate.ts, which clipped
// head-OR-tail. That is the legacy path. The current V2 store preserves the
// beginning AND end — which is what CONTEXT.md specifies, and what lets a tool put
// framing (a pagination hint, an exit code, a stderr block) at the end of its
// output and still have the model see it.

function envInt(name: string, fallback: number) {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * Overridable by environment until a real config layer exists. Kept as a
 * function of the environment rather than a frozen constant so a later config
 * layer can supply limits without changing any call site.
 */
export const MAX_LINES = envInt("COMPASS_TOOL_OUTPUT_MAX_LINES", 2000)
export const MAX_BYTES = envInt("COMPASS_TOOL_OUTPUT_MAX_BYTES", 50 * 1024)

/** Reserved for the marker and its blank-line padding. */
const MARKER_RESERVE = 4

export interface Options {
  readonly maxLines?: number
  readonly maxBytes?: number
  /** Marker placed between the kept head and tail. */
  readonly marker?: string
  /** Appended to the marker. Used to name the spill file holding the full text. */
  readonly note?: string
}

export type Result =
  | { readonly content: string; readonly truncated: false }
  | { readonly content: string; readonly truncated: true; readonly removed: number; readonly unit: "lines" | "bytes" }

/** Characters from the start, stopping before the byte budget is exceeded. */
function takePrefix(input: string, maximumBytes: number) {
  let bytes = 0
  let content = ""
  for (const char of input) {
    const size = Buffer.byteLength(char, "utf-8")
    if (bytes + size > maximumBytes) break
    content += char
    bytes += size
  }
  return content
}

/**
 * Characters from the end. Iterates code points rather than UTF-16 units, so a
 * cut never splits a surrogate pair into a lone surrogate.
 */
function takeSuffix(input: string, maximumBytes: number) {
  let bytes = 0
  const content: string[] = []
  for (const char of Array.from(input).toReversed()) {
    const size = Buffer.byteLength(char, "utf-8")
    if (bytes + size > maximumBytes) break
    content.unshift(char)
    bytes += size
  }
  return content.join("")
}

export function preview(text: string, maxLines: number, maxBytes: number) {
  const lines = text.split("\n")
  const headLines = Math.ceil(maxLines / 2)
  const tailLines = Math.floor(maxLines / 2)
  const sampled =
    lines.length <= maxLines
      ? text
      : [
          lines.slice(0, headLines).join("\n"),
          ...(tailLines > 0 ? [lines.slice(lines.length - tailLines).join("\n")] : []),
        ].join("\n")
  if (Buffer.byteLength(sampled, "utf-8") <= maxBytes) {
    return lines.length <= maxLines
      ? { head: sampled, tail: "" }
      : {
          head: lines.slice(0, headLines).join("\n"),
          tail: tailLines > 0 ? lines.slice(lines.length - tailLines).join("\n") : "",
        }
  }
  const headBytes = Math.ceil(maxBytes / 2)
  const tailBytes = Math.floor(maxBytes / 2)
  return { head: takePrefix(sampled, headBytes), tail: takeSuffix(sampled, tailBytes) }
}

function lineCount(text: string) {
  let count = 1
  for (const char of text) if (char === "\n") count++
  return count
}

/** True when `text` would be bounded. Lets a caller spill before bounding. */
export function exceeds(text: string, options: Options = {}) {
  return (
    lineCount(text) > (options.maxLines ?? MAX_LINES) ||
    Buffer.byteLength(text, "utf-8") > (options.maxBytes ?? MAX_BYTES)
  )
}

/**
 * Bounds text to whichever limit is reached first, keeping the beginning and the
 * end. Tools must not call this themselves — the registry is the single bounding
 * boundary, so no tool can opt out of it.
 */
export function bound(text: string, options: Options = {}): Result {
  const maxLines = options.maxLines ?? MAX_LINES
  const maxBytes = options.maxBytes ?? MAX_BYTES
  const totalLines = lineCount(text)
  const totalBytes = Buffer.byteLength(text, "utf-8")

  if (totalLines <= maxLines && totalBytes <= maxBytes) return { content: text, truncated: false }

  const byLines = totalLines > maxLines
  const removed = byLines ? totalLines - maxLines : totalBytes - maxBytes
  const unit = byLines ? "lines" : "bytes"
  const base = options.marker ?? `...${removed} ${unit} truncated...`
  const marker = options.note === undefined ? base : `${base}\n${options.note}`
  const markerBytes = Buffer.byteLength(marker, "utf-8")

  // Degenerate budgets cannot fit both the marker and any content.
  if (maxLines <= MARKER_RESERVE || maxBytes <= markerBytes + MARKER_RESERVE) {
    return {
      content: takePrefix(marker, maxBytes).split("\n").slice(0, maxLines).join("\n"),
      truncated: true,
      removed,
      unit,
    }
  }

  const bounded = preview(text, maxLines - MARKER_RESERVE, maxBytes - markerBytes - MARKER_RESERVE)
  return {
    content: bounded.tail ? `${bounded.head}\n\n${marker}\n\n${bounded.tail}` : `${bounded.head}\n\n${marker}`,
    truncated: true,
    removed,
    unit,
  }
}
