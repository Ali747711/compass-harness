#!/usr/bin/env bun
import { SessionID } from "@compass/schema"
import { layerDefault } from "@compass/core/database/database"
import { RETRY_MAX_RETRIES } from "@compass/core/session/retry"
import { SessionRun } from "@compass/core/session/run"
import { SessionStore, layer as storeLayer } from "@compass/core/session/store"
import { at, layer as locationsLayer } from "@compass/core/location/service-map"
import { Spill } from "@compass/core/tool/spill"
import { layerAllowAll } from "@compass/core/permission/permission"
import { layer as projectLayer } from "@compass/core/project/project"
import { Effect, Layer } from "effect"
import { parseArgs } from "node:util"

/**
 * Global services are built once. The tool registry and session runner are
 * Location-scoped and come from the service map, memoized per project, so one
 * process can serve many directories.
 */
const MainLayer = locationsLayer.pipe(
  Layer.provideMerge(projectLayer),
  Layer.provideMerge(storeLayer),
  Layer.provideMerge(layerAllowAll),
  Layer.provideMerge(layerDefault),
)

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    session: { type: "string", short: "s" },
    model: { type: "string", short: "m" },
    help: { type: "boolean", short: "h" },
  },
})

const HELP = `compass — terminal AI coding agent harness

Usage:
  compass [options] <prompt>     send a prompt
  compass sessions               list sessions

Options:
  -s, --session <id>   continue an existing session
  -m, --model <ref>    provider/model (default: anthropic/claude-sonnet-4-5)
  -h, --help           show this help
`

const program = Effect.gen(function* () {
  if (values.help || positionals.length === 0) {
    process.stdout.write(HELP)
    return
  }

  const store = yield* SessionStore

  if (positionals[0] === "sessions") {
    const sessions = yield* store.list()
    if (sessions.length === 0) {
      process.stdout.write("no sessions yet\n")
      return
    }
    for (const session of sessions) {
      process.stdout.write(`${session.id}  ${new Date(session.timeUpdated).toISOString()}  ${session.title}\n`)
    }
    return
  }

  const text = positionals.join(" ")
  const session = values.session
    ? yield* store.get(SessionID.make(values.session))
    : yield* store.create({ title: text.slice(0, 60), directory: process.cwd() })

  if (!values.session) process.stderr.write(`session ${session.id}\n\n`)

  // The session's directory selects its Location.
  const run = yield* Effect.provide(SessionRun, at({ directory: session.directory }))
  yield* run.prompt({
    sessionID: session.id,
    text,
    ...(values.model === undefined ? {} : { model: values.model }),
    sink: {
      text: (delta) => process.stdout.write(delta),
      // Tool activity goes to stderr so piping stdout still yields clean model text.
      tool: (event) => {
        // Emitted the moment the model names the tool, before its arguments have
        // finished streaming — otherwise nothing is shown for that whole gap.
        if (event.state === "pending") return process.stderr.write(`\n  ⋯ ${event.name}\n`)
        if (event.state === "running") return undefined
        const mark = event.state === "error" ? "✗" : "✓"
        process.stderr.write(`  ${mark} ${event.name}${event.title ? ` — ${event.title}` : ""}\n`)
      },
      // Reasoning goes to stderr, dimmed, so piping stdout still yields only the
      // answer — but the terminal is not silent while a reasoning model thinks.
      reasoning: (delta) => process.stderr.write(`\u001b[2m${delta}\u001b[0m`),
      // Also stderr. A retry replays the turn, so whatever the failed attempt
      // already streamed to stdout is about to be said a second time — this
      // line is what makes that legible rather than baffling.
      retry: (attempt) => {
        const seconds = Math.max(1, Math.round((attempt.next - Date.now()) / 1000))
        process.stderr.write(
          `\n  ⟳ ${attempt.message} — retrying in ${seconds}s (${attempt.attempt}/${RETRY_MAX_RETRIES})\n`,
        )
      },
      // Compaction is lossy and costs a provider call, so it is never silent.
      compaction: (event) => {
        if (event.state === "started") return process.stderr.write(`\n  ⊞ compacting the conversation…\n`)
        if (event.state === "completed") return process.stderr.write(`  ⊞ compacted\n`)
        process.stderr.write(`  ⊞ compaction skipped — ${event.reason ?? "no reason given"}\n`)
      },
      // Otherwise the reply just stops, and a sentence ending mid-word looks
      // like the model chose to stop there.
      incomplete: (event) => process.stderr.write(`\n  ⚠ incomplete — ${event.detail}\n`),
    },
  })
  process.stdout.write("\n")

  // Retention sweep. There is no session-close lifecycle yet, so the age-based
  // half of the cleanup rule runs here; it is a readdir over one small directory.
  yield* Spill.sweep(session.directory).pipe(Effect.ignore)
})

/**
 * One actionable line, never a stack trace. A tagged failure carries a message
 * written for the person reading it; anything else is a genuine defect and its
 * message is the most useful thing we have.
 */
function explain(error: unknown) {
  if (typeof error === "object" && error !== null && "message" in error) {
    const detail = String((error as { message: unknown }).message)
    // Effect wraps failures; take the first line so a cause dump never reaches the terminal.
    return detail.split("\n")[0]!
  }
  return String(error)
}

await Effect.runPromise(program.pipe(Effect.provide(MainLayer), Effect.scoped)).catch((error) => {
  process.stderr.write(`${explain(error)}\n`)
  process.exit(1)
})
