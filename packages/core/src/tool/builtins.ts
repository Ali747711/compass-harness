import { bashTool } from "./bash"
import { editTool } from "./edit"
import { globTool } from "./glob"
import { grepTool } from "./grep"
import { readTool } from "./read"
import type { Registration } from "./registry"
import { writeTool } from "./write"

/**
 * Registration order is the order the model sees tool definitions in.
 * Read-before-write reads better to a model than alphabetical.
 */
export const builtins: readonly Registration[] = [
  { name: "read", tool: readTool },
  { name: "write", tool: writeTool },
  { name: "edit", tool: editTool },
  { name: "bash", tool: bashTool },
  { name: "grep", tool: grepTool },
  { name: "glob", tool: globTool },
]
