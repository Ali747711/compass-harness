import { Effect, Schema } from "effect"
import { existsSync } from "node:fs"
import { make, ToolFailure, type Context } from "./tool"

const DEFAULT_TIMEOUT = 120_000
const MAX_TIMEOUT = 600_000

/** Grace period between SIGTERM and SIGKILL for a process that ignores the first. */
const KILL_GRACE = 2_000

/**
 * Resolved once, and deliberately not from $SHELL: the tool is named `bash` and
 * its description promises bash syntax, so inheriting an interactive fish or
 * nushell would silently break every command the model writes.
 */
const SHELL = existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh"

const DESCRIPTION = `Executes a bash command in the session's working directory and returns its output.

Each call runs in a fresh non-interactive shell, so nothing carries over between calls: \`cd\`, exported variables, shell functions, and activated virtualenvs are all gone by the next invocation. Chain dependent steps inside a single call (\`cd packages/core && bun test\`) or use absolute paths.

This tool is for terminal operations - git, package managers, build systems, test runners, formatters, docker, gh, and other CLIs. Do NOT use it for file operations; the dedicated tools are faster and give you structured results:
- Find files: use the glob tool, NOT \`find\` or \`ls\`
- Search file contents: use the grep tool, NOT \`grep\` or \`rg\`
- Read files: use the read tool, NOT \`cat\`, \`head\`, or \`tail\`
- Change files: use the edit or write tool, NOT \`sed\`, \`awk\`, \`echo >\`, or heredocs
- Tell the user something: say it in your reply, NOT \`echo\`

Before running a command:
1. If it creates files or directories, confirm the parent directory exists first (\`ls foo\` before \`mkdir foo/bar\`).
2. Quote every path containing spaces: \`python "/path/with spaces/script.py"\` is correct, \`python /path/with spaces/script.py\` is not.
3. Prefer non-interactive flags. Stdin is an empty stream, so anything waiting for input reads EOF immediately and may fail or misbehave - pass \`-y\`, \`--yes\`, \`--no-input\`, \`--no-pager\`, \`GIT_TERMINAL_PROMPT=0\` and friends instead of expecting to answer a prompt.

Usage notes:
- \`command\` is required.
- \`description\` is required: 5-10 words, active voice, describing what the command does ("Run the core test suite", "Install npm dependencies"). It is shown to the user, not to you.
- \`timeout\` is in milliseconds. It defaults to ${DEFAULT_TIMEOUT} and is capped at ${MAX_TIMEOUT}; larger values are clamped to the cap. When a command times out it is killed, you receive whatever it printed before the kill, and you should either retry with a larger timeout (if the work is genuinely slow) or rerun it non-interactively (if it was blocked waiting for input).
- A non-zero exit code is NOT a tool error. You get the output and the exit code back and decide what to do next; read stderr before retrying.
- Output is capped at roughly 2000 lines or 50KB and the overflow is dropped from the end. If a command is known to be enormously chatty, narrow it at the source with a quieter flag or a more specific target rather than expecting to read all of it.
- Do not use newlines to separate commands (newlines inside quoted strings are fine). Use \`&&\` when a later command depends on an earlier one succeeding and \`;\` when it does not.
- Run genuinely independent commands as several parallel tool calls in one message instead of joining them with \`&&\`.

Git and GitHub:
- Only commit, amend, push, or open PRs when explicitly asked to.
- Before committing, inspect \`git status\`, \`git diff\`, and \`git log --oneline -10\`; stage only the intended files and never commit secrets.
- Write a concise commit message matching the repository's existing style.
- Do not change git config, skip hooks, use interactive \`-i\` flags, force-push, or create empty commits unless explicitly asked to.
- If a commit fails or a hook rejects it, fix the problem and make a new commit; do not amend the failed one.
- Before opening a PR, inspect status, diff, remote tracking, recent commits, and the diff against the base branch, and review every commit in the PR rather than only the latest.
- Use \`gh\` for GitHub work and return the PR URL when you are done.`

const Parameters = Schema.Struct({
  command: Schema.String.annotations({
    description: "The bash command to execute. Runs in the session's working directory in a fresh shell.",
  }),
  timeout: Schema.optional(
    Schema.Number.pipe(Schema.int(), Schema.positive()).annotations({
      description: `Timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT}, clamped to a maximum of ${MAX_TIMEOUT}.`,
    }),
  ),
  description: Schema.String.annotations({
    description:
      "What this command does, in 5-10 words of active voice (e.g. 'Run the core test suite'). Shown to the user.",
  }),
})

type Parameters = typeof Parameters.Type

interface Outcome {
  readonly stdout: string
  readonly stderr: string
  readonly code: number
  readonly signal: string | null
  readonly timedOut: boolean
  readonly aborted: boolean
}

/**
 * Signals the whole process group rather than just the shell. `sh -c "a; b"`
 * forks for each command, and killing only the shell leaves those children
 * holding the output pipes open — the read below would then never finish.
 * A throw here means the group is already gone, which is the desired end state.
 */
function terminate(proc: Bun.Subprocess, signal: NodeJS.Signals) {
  try {
    process.kill(-proc.pid, signal)
  } catch {
    proc.kill(signal)
  }
}

async function run(command: string, timeout: number, context: Context): Promise<Outcome> {
  const proc = Bun.spawn([SHELL, "-c", command], {
    cwd: context.directory,
    // An empty stdin makes commands that read it see EOF at once. Inheriting the
    // harness's stdin would let a stray `cat` or prompt hang the whole turn.
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    // Own process group, so `terminate` can reach grandchildren.
    detached: true,
  })

  let timedOut = false
  let aborted = false
  let force: ReturnType<typeof setTimeout> | undefined

  const stop = () => {
    terminate(proc, "SIGTERM")
    force = setTimeout(() => terminate(proc, "SIGKILL"), KILL_GRACE)
  }

  const expire = setTimeout(() => {
    timedOut = true
    stop()
  }, timeout)

  const onAbort = () => {
    aborted = true
    stop()
  }
  context.abort.addEventListener("abort", onAbort, { once: true })

  // Both pipes are drained concurrently with the exit wait: a process that fills
  // its stdout buffer blocks forever if nobody is reading.
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).finally(() => {
    clearTimeout(expire)
    if (force !== undefined) clearTimeout(force)
    context.abort.removeEventListener("abort", onAbort)
  })

  return { stdout, stderr, code, signal: proc.signalCode, timedOut, aborted }
}

function reason(cause: unknown) {
  if (cause instanceof Error) return cause.message
  return String(cause)
}

function render(outcome: Outcome, timeout: number) {
  const stdout = outcome.stdout.trimEnd()
  const stderr = outcome.stderr.trimEnd()

  const body: string[] = []
  if (stdout.length > 0) body.push(stdout)
  if (stderr.length > 0) body.push(`<stderr>\n${stderr}\n</stderr>`)

  const notes: string[] = []
  if (outcome.timedOut) {
    notes.push(
      `Command exceeded its ${timeout}ms timeout and was killed. Any output above is what it produced before the kill. Retry with a larger timeout if the work is genuinely slow, or rerun it non-interactively if it was waiting for input.`,
    )
  }
  if (outcome.aborted) notes.push("Command was aborted by the user and killed.")
  if (outcome.code !== 0) {
    const signal = outcome.signal === null ? "" : ` (terminated by ${outcome.signal})`
    notes.push(`Exit code: ${outcome.code}${signal}`)
  }

  const text = body.length > 0 ? body.join("\n\n") : "(no output)"
  if (notes.length === 0) return text
  return `${text}\n\n<bash_metadata>\n${notes.join("\n")}\n</bash_metadata>`
}

export const bashTool = make<Parameters>({
  description: DESCRIPTION,
  input: Parameters,
  permission: "bash",
  execute: (input, context) =>
    Effect.gen(function* () {
      const command = input.command.trim()
      if (command.length === 0) {
        return yield* Effect.fail(new ToolFailure({ message: "command is required and must not be empty" }))
      }
      if (context.abort.aborted) {
        return yield* Effect.fail(new ToolFailure({ message: "Aborted before the command started" }))
      }

      const timeout = Math.min(input.timeout ?? DEFAULT_TIMEOUT, MAX_TIMEOUT)
      const outcome = yield* Effect.tryPromise({
        try: () => run(command, timeout, context),
        // Spawn failures are almost always a missing or unreadable working
        // directory, which the model can fix by pointing somewhere real.
        catch: (cause) =>
          new ToolFailure({
            message: `Could not run the command in ${context.directory}: ${reason(cause)}`,
          }),
      })

      const label = input.description.trim()
      return {
        title: label.length > 0 ? label : command,
        output: render(outcome, timeout),
        metadata: {
          command,
          exit: outcome.code,
          signal: outcome.signal,
          timeout,
          timedOut: outcome.timedOut,
          aborted: outcome.aborted,
        },
      }
    }),
})
