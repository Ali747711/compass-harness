#!/usr/bin/env bun
import { SessionID } from "@compass/schema"
import { layerDefault } from "@compass/core/database/database"
import { SessionRun, layer as runLayer } from "@compass/core/session/run"
import { SessionStore, layer as storeLayer } from "@compass/core/session/store"
import { builtins } from "@compass/core/tool/builtins"
import { layer as registryLayer } from "@compass/core/tool/registry"
import { Effect, Layer } from "effect"
import { parseArgs } from "node:util"

const MainLayer = runLayer.pipe(
  Layer.provideMerge(storeLayer),
  Layer.provideMerge(registryLayer(builtins)),
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

  const run = yield* SessionRun
  yield* run.prompt({
    sessionID: session.id,
    text,
    ...(values.model === undefined ? {} : { model: values.model }),
    sink: {
      text: (delta) => process.stdout.write(delta),
      // Tool activity goes to stderr so piping stdout still yields clean model text.
      tool: (event) => {
        if (event.state === "running") return process.stderr.write(`\n  ⋯ ${event.name}\n`)
        const mark = event.state === "error" ? "✗" : "✓"
        process.stderr.write(`  ${mark} ${event.name}${event.title ? ` — ${event.title}` : ""}\n`)
      },
    },
  })
  process.stdout.write("\n")
})

await Effect.runPromise(program.pipe(Effect.provide(MainLayer), Effect.scoped)).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
