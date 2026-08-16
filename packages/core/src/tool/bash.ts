import { Effect, Schema } from "effect"
import { existsSync } from "node:fs"
import { make, render as renderDescription, ToolFailure, type Context } from "./tool"
import DESCRIPTION from "./bash.txt"
import { MAX_BYTES, MAX_LINES } from "./truncate"

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

const Parameters = Schema.Struct({
  command: Schema.String.annotate({
    description: "The bash command to execute. Runs in the session's working directory in a fresh shell.",
  }),
  timeout: Schema.optionalKey(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)).annotate({
      description: `Timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT}, clamped to a maximum of ${MAX_TIMEOUT}.`,
    }),
  ),
  description: Schema.String.annotate({
    description:
      "What this command does, in 5-10 words of active voice (e.g. 'Run the core test suite'). Shown to the user.",
  }),
})

type Parameters = typeof Parameters.Type

type Child = Bun.Subprocess<"ignore", "pipe", "pipe">

type Origin = "stdout" | "stderr"

/** One read from one pipe, kept in arrival order so the two streams can be interleaved. */
interface Segment {
  readonly origin: Origin
  readonly text: string
}

interface Outcome {
  readonly segments: readonly Segment[]
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
function terminate(proc: Child, signal: NodeJS.Signals) {
  try {
    process.kill(-proc.pid, signal)
  } catch {
    proc.kill(signal)
  }
}

/**
 * SIGTERM first so the command can clean up, SIGKILL after a grace period for
 * anything that traps or ignores the first signal. Returns a canceller for the
 * escalation timer, which must be called once the process is reaped so the
 * timer does not hold the event loop open.
 */
function stop(proc: Child) {
  terminate(proc, "SIGTERM")
  const force = setTimeout(() => terminate(proc, "SIGKILL"), KILL_GRACE)
  return () => clearTimeout(force)
}

/**
 * Reads one pipe to EOF, appending each chunk to the shared sink. The sink is a
 * single array for both pipes on purpose: push order is arrival order, which is
 * how the two streams get interleaved. Decoding is incremental so a multi-byte
 * character split across two chunks is not corrupted.
 */
async function drain(readable: ReadableStream<Uint8Array>, origin: Origin, sink: Segment[]) {
  const reader = readable.getReader()
  const decoder = new TextDecoder()
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    const text = decoder.decode(chunk.value, { stream: true })
    if (text.length > 0) sink.push({ origin, text })
  }
  const tail = decoder.decode()
  if (tail.length > 0) sink.push({ origin, text: tail })
}

async function collect(proc: Child, timeout: number, context: Context): Promise<Outcome> {
  const segments: Segment[] = []

  let timedOut = false
  let aborted = false
  let cancelForce: (() => void) | undefined

  // Idempotent: a command can both time out and be aborted, and a second
  // escalation timer would outlive the first canceller.
  const halt = () => {
    if (cancelForce !== undefined) return
    cancelForce = stop(proc)
  }

  const expire = setTimeout(() => {
    timedOut = true
    halt()
  }, timeout)

  const onAbort = () => {
    aborted = true
    halt()
  }
  context.abort.addEventListener("abort", onAbort, { once: true })
  // An already-aborted signal never fires its listener, so an abort that landed
  // between the check at entry and this line would otherwise leave the command
  // running for its full timeout.
  if (context.abort.aborted) onAbort()

  // Both pipes are drained concurrently with the exit wait: a process that fills
  // its stdout buffer blocks forever if nobody is reading.
  const [, , code] = await Promise.all([
    drain(proc.stdout, "stdout", segments),
    drain(proc.stderr, "stderr", segments),
    proc.exited,
  ]).finally(() => {
    clearTimeout(expire)
    cancelForce?.()
    context.abort.removeEventListener("abort", onAbort)
  })

  return { segments, code, signal: proc.signalCode, timedOut, aborted }
}

function spawn(command: string, context: Context) {
  return Effect.try({
    try: (): Child =>
      Bun.spawn([SHELL, "-c", command], {
        cwd: context.directory,
        // An empty stdin makes commands that read it see EOF at once. Inheriting the
        // harness's stdin would let a stray `cat` or prompt hang the whole turn.
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        // Own process group, so `terminate` can reach grandchildren.
        detached: true,
      }),
    // Spawn failures are almost always a missing or unreadable working
    // directory, which the model can fix by pointing somewhere real.
    catch: (cause) =>
      new ToolFailure({
        message: `Could not run the command in ${context.directory}: ${reason(cause)}`,
      }),
  })
}

/**
 * Runs on every exit path, fiber interruption included — and interruption is the
 * one path that never reaches `collect`'s own cleanup, because Effect abandons
 * the pending promise. Without this the child and its whole process group keep
 * running after the turn that spawned them is gone.
 */
async function reap(proc: Child) {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  const cancelForce = stop(proc)
  await proc.exited
  cancelForce()
}

function reason(cause: unknown) {
  if (cause instanceof Error) return cause.message
  return String(cause)
}

/** Adjacent reads from the same pipe are one block; alternating reads are not. */
function merge(segments: readonly Segment[]): readonly Segment[] {
  return segments.reduce<readonly Segment[]>((blocks, segment) => {
    const last = blocks.at(-1)
    if (last === undefined || last.origin !== segment.origin) return [...blocks, segment]
    return [...blocks.slice(0, -1), { origin: last.origin, text: last.text + segment.text }]
  }, [])
}

function render(outcome: Outcome, timeout: number) {
  const body = merge(outcome.segments).flatMap((block) => {
    const text = block.text.trimEnd()
    if (text.length === 0) return []
    return [block.origin === "stderr" ? `<stderr>\n${text}\n</stderr>` : text]
  })

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

  const text = body.length > 0 ? body.join("\n") : "(no output)"
  if (notes.length === 0) return text
  return `${text}\n\n<bash_metadata>\n${notes.join("\n")}\n</bash_metadata>`
}

export const bashTool = make<Parameters>({
  description: renderDescription(DESCRIPTION, {
    DEFAULT_TIMEOUT,
    MAX_TIMEOUT,
    MAX_LINES,
    MAX_KB: Math.round(MAX_BYTES / 1024),
  }),
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
      // Bracketed so the child is killed on fiber interruption too, not only on
      // the abort signal and the timeout that `collect` watches itself.
      const outcome = yield* Effect.acquireUseRelease(
        spawn(command, context),
        (proc) =>
          Effect.tryPromise({
            try: () => collect(proc, timeout, context),
            catch: (cause) =>
              new ToolFailure({
                message: `Could not read the output of the command in ${context.directory}: ${reason(cause)}`,
              }),
          }),
        (proc) => Effect.promise(() => reap(proc)),
      )

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
