# compass-harness

A terminal AI coding agent harness. No desktop app, no web UI.

## Status

**M1.6 — Location scoping.** Working terminal agent: streaming provider calls, a six-tool loop,
session persistence, a permission seam, and one memoized service graph per project.

| Milestone                          | State |
| ---------------------------------- | ----- |
| M0 skeleton + streaming            | done  |
| M1 tool loop                       | done  |
| M1.5 Effect 4 migration            | done  |
| M1.6 LayerNode + Location scoping  | done  |
| M1.7 durable events + projector    | next  |
| M2 durable admission + steer/queue |       |
| M3 server + worker transport       |       |
| M4 TUI                             |       |
| M5 instructions + skills           |       |
| M6 MCP + permission ruleset        |       |
| M7 subagents                       |       |

## Requirements

- Bun 1.3.14
- `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY` with `--model openai/<model>`)

## Usage

```bash
bun install
bun run compass "explain this repo"
bun run compass --session ses_... "and the database layer?"
bun run compass sessions
```

| Variable           | Default                             |
| ------------------ | ----------------------------------- |
| `COMPASS_DB`       | `~/.local/share/compass/compass.db` |
| `COMPASS_PROVIDER` | `anthropic`                         |
| `COMPASS_MODEL`    | `claude-sonnet-4-5`                 |

## Development

```bash
bun run typecheck   # tsc --noEmit across the workspace
bun run lint        # oxlint
bun run test        # bun test per package
bun run format      # prettier
```

## Packages

| Package           | Owns                                                                | Depends on        |
| ----------------- | ------------------------------------------------------------------- | ----------------- |
| `@compass/schema` | Effect Schema contracts. No services, no side effects.              | `effect`          |
| `@compass/core`   | Sessions, storage, tools, permissions, providers, Location scoping. | `@compass/schema` |
| `@compass/cli`    | Entrypoint.                                                         | `@compass/core`   |

### Scoping

`Database`, `Permission` and `SessionStore` are global and built once. `ToolRegistry` and
`SessionRun` are **Location-scoped**: one memoized service graph per project or worktree, keyed by
directory, so a single process serves many checkouts. A session's directory selects its Location.

`api`, `server`, and `tui` arrive with the milestones that need them (M3, M3, M4).

Bun's isolated linker enforces these boundaries at the resolver: `packages/schema/node_modules`
contains only `effect` and `ulid`, so schema physically cannot import the AI SDK or Drizzle.

## Design notes

Architecture follows [opencode](https://github.com/anomalyco/opencode) where it earns its place:
durable prompt admission separated from execution, steer-vs-queue delivery, a child-session
subagent model, and a worker-thread HTTP transport. It diverges by dropping the SDK codegen
pipeline — `HttpApiClient.make(Api)` derives a typed client from the same value at runtime.

Ported code is credited in [ATTRIBUTION.md](ATTRIBUTION.md); opencode is MIT and its license is
retained at [licenses/opencode-MIT.txt](licenses/opencode-MIT.txt).
