// Adapted from opencode (MIT). Source: packages/opencode/src/tool/truncate.ts
// https://github.com/anomalyco/opencode — see licenses/opencode-MIT.txt
//
// Reduced to a pure function: opencode writes overflow to a managed file under a
// retention directory and points the model at it. That needs a tool-output store,
// which lands later; until then oversized output is bounded and the loss is stated.

export const MAX_LINES = 2000
export const MAX_BYTES = 50 * 1024

export interface Options {
  readonly maxLines?: number
  readonly maxBytes?: number
  readonly direction?: "head" | "tail"
}

export type Result =
  | { readonly content: string; readonly truncated: false }
  | { readonly content: string; readonly truncated: true; readonly removed: number; readonly unit: "lines" | "bytes" }

/**
 * Bounds text to whichever limit is reached first. `head` keeps the beginning,
 * `tail` keeps the end — callers pick based on where the signal lives (shell
 * output is usually `tail`, file reads `head`).
 */
export function bound(text: string, options: Options = {}): Result {
  const maxLines = options.maxLines ?? MAX_LINES
  const maxBytes = options.maxBytes ?? MAX_BYTES
  const direction = options.direction ?? "head"
  const lines = text.split("\n")
  const totalBytes = Buffer.byteLength(text, "utf-8")

  if (lines.length <= maxLines && totalBytes <= maxBytes) return { content: text, truncated: false }

  const out: string[] = []
  let bytes = 0
  let hitBytes = false

  if (direction === "head") {
    for (let i = 0; i < lines.length && i < maxLines; i++) {
      const line = lines[i] ?? ""
      const size = Buffer.byteLength(line, "utf-8") + (i > 0 ? 1 : 0)
      if (bytes + size > maxBytes) {
        hitBytes = true
        break
      }
      out.push(line)
      bytes += size
    }
  } else {
    for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
      const line = lines[i] ?? ""
      const size = Buffer.byteLength(line, "utf-8") + (out.length > 0 ? 1 : 0)
      if (bytes + size > maxBytes) {
        hitBytes = true
        break
      }
      out.unshift(line)
      bytes += size
    }
  }

  const removed = hitBytes ? totalBytes - bytes : lines.length - out.length
  const unit = hitBytes ? "bytes" : "lines"
  const preview = out.join("\n")
  const notice = `...${removed} ${unit} truncated...`

  return {
    content: direction === "head" ? `${preview}\n\n${notice}` : `${notice}\n\n${preview}`,
    truncated: true,
    removed,
    unit,
  }
}
