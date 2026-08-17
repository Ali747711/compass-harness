// Adapted from opencode (MIT). Source: packages/opencode/src/agent/agent.ts
// https://github.com/anomalyco/opencode — see licenses/opencode-MIT.txt
//
// Diverges from the original: theirs merges built-ins, a config file's `agent`
// key, and markdown files with YAML frontmatter, and carries model, temperature
// and tool filters. There is no config layer here yet, so this is built-ins
// plus the markdown discovery — which is the part that matters, because it is
// what makes adding an agent cost no code.

import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import type { Ruleset } from "../permission/ruleset"

export interface Agent {
  readonly name: string
  /** Shown to the model when it chooses which agent to delegate to. */
  readonly description: string
  /** Replaces the primary system prompt for the child session. */
  readonly prompt: string
  /** The agent's own capabilities, before the parent's denies are layered on. */
  readonly permission: Ruleset
}

/**
 * Built-in agents.
 *
 * `explore` is read-only by construction rather than by instruction: telling a
 * model not to edit is a request, denying `edit` and `write` is a rule. That
 * distinction is the reason delegating a search is safe.
 */
const BUILTIN: readonly Agent[] = [
  {
    name: "explore",
    description:
      "Searches and reads the codebase to answer a question. Cannot modify anything. Use for locating code, tracing behaviour, or summarising how something works.",
    prompt: [
      "You are a read-only exploration agent.",
      "Find what was asked for and report it concisely, citing file paths and line numbers.",
      "You cannot modify files; do not attempt to, and do not propose edits as if you had made them.",
      "Answer the question directly. The agent that delegated to you will act on what you return.",
    ].join(" "),
    permission: [
      { permission: "read", pattern: "*", action: "allow" },
      { permission: "grep", pattern: "*", action: "allow" },
      { permission: "glob", pattern: "*", action: "allow" },
      { permission: "edit", pattern: "*", action: "deny" },
      { permission: "write", pattern: "*", action: "deny" },
    ],
  },
  {
    name: "general",
    description:
      "A general-purpose agent with the same tools as the main one. Use for self-contained work that would otherwise fill the main conversation with detail.",
    prompt: [
      "You are a general-purpose agent working on one delegated task.",
      "Complete it and report what you did and what you found.",
      "Be concise: your reply is read by another agent, not a person.",
    ].join(" "),
    permission: [],
  },
]

/**
 * Parses a markdown agent file: YAML-ish frontmatter is configuration, the body
 * is the system prompt.
 *
 * Only `description` and `permission` are read from frontmatter, and the parser
 * is deliberately small — a full YAML dependency for two keys is not a trade
 * worth making, and a malformed file degrades to "no frontmatter" rather than
 * taking the session down.
 */
export function parseAgentFile(name: string, source: string): Agent {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(source)
  const body = match === null ? source : source.slice(match[0].length)
  const frontmatter = match?.[1] ?? ""

  let description = `The ${name} agent.`
  const permission: { permission: string; pattern: string; action: "allow" | "deny" | "ask" }[] = []

  for (const line of frontmatter.split("\n")) {
    const described = /^description:\s*(.+)$/.exec(line.trim())
    if (described?.[1] !== undefined) description = described[1].replace(/^["']|["']$/g, "")
    // `  bash: deny` or `  edit: allow`, nested under a `permission:` key.
    const rule = /^\s+([A-Za-z_][A-Za-z0-9_-]*):\s*(allow|deny|ask)\s*$/.exec(line)
    if (rule?.[1] !== undefined && rule[2] !== undefined) {
      permission.push({ permission: rule[1], pattern: "*", action: rule[2] as "allow" | "deny" | "ask" })
    }
  }

  return { name, description, prompt: body.trim(), permission }
}

/** Agent definitions found in `.compass/agent/*.md` under the project. */
export function discoverAgents(project: string): readonly Agent[] {
  const directory = join(project, ".compass", "agent")
  if (!existsSync(directory)) return []
  try {
    return readdirSync(directory)
      .filter((entry) => entry.endsWith(".md"))
      .map((entry) => {
        const name = entry.slice(0, -3)
        return parseAgentFile(name, readFileSync(join(directory, entry), "utf-8"))
      })
      .filter((agent) => agent.prompt.length > 0)
  } catch {
    return []
  }
}

/**
 * Every agent available in a project, definitions overriding built-ins by name
 * so a project can reshape `explore` without forking the harness.
 */
export function agents(project: string): readonly Agent[] {
  const found = new Map<string, Agent>()
  for (const agent of BUILTIN) found.set(agent.name, agent)
  for (const agent of discoverAgents(project)) found.set(agent.name, agent)
  return [...found.values()]
}

export const find = (project: string, name: string) => agents(project).find((agent) => agent.name === name)
