import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer, LayerMap } from "effect"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { layerMemory } from "../src/database/database"
import { Location, key } from "../src/location/location"
import { LocationServiceMap, at, layer as mapLayer } from "../src/location/service-map"
import { layerAllowAll } from "../src/permission/permission"
import { layer as projectLayer, resolveProject } from "../src/project/project"
import { SessionRun } from "../src/session/run"
import { SessionStore, layer as storeLayer } from "../src/session/store"
import { ToolRegistry } from "../src/tool/registry"

const Global = mapLayer.pipe(
  Layer.provideMerge(projectLayer),
  Layer.provideMerge(storeLayer),
  Layer.provideMerge(layerAllowAll),
  Layer.provideMerge(layerMemory),
)

const run = <A, E>(effect: Effect.Effect<A, E, LocationServiceMap | SessionStore>) =>
  Effect.runPromise(effect.pipe(Effect.provide(Global), Effect.scoped) as Effect.Effect<A, E>)

function scratch() {
  return mkdtempSync(join(tmpdir(), "loc-"))
}

describe("Location key", () => {
  test("distinguishes directories", () => {
    expect(key({ directory: "/a" })).not.toBe(key({ directory: "/b" }))
  })

  test("distinguishes workspaces sharing a directory", () => {
    expect(key({ directory: "/a" })).not.toBe(key({ directory: "/a", workspaceID: "w1" as never }))
  })

  test("is stable for the same ref", () => {
    expect(key({ directory: "/a" })).toBe(key({ directory: "/a" }))
  })
})

describe("Project resolution", () => {
  test("treats a directory outside any repository as its own project", () => {
    const dir = scratch()
    const project = resolveProject(dir)
    expect(project.vcs).toBeUndefined()
    expect(project.id.startsWith("prj_")).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  test("walks up to the repository root and marks it git", () => {
    const dir = scratch()
    execFileSync("git", ["init", "-q"], { cwd: dir })
    const nested = join(dir, "src", "deep")
    mkdirSync(nested, { recursive: true })
    const fromRoot = resolveProject(dir)
    const fromNested = resolveProject(nested)
    expect(fromNested.directory).toBe(fromRoot.directory)
    expect(fromNested.id).toBe(fromRoot.id)
    expect(fromNested.vcs).toBe("git")
    rmSync(dir, { recursive: true, force: true })
  })

  test("gives two unrelated repositories different project ids", () => {
    const a = scratch()
    const b = scratch()
    execFileSync("git", ["init", "-q"], { cwd: a })
    execFileSync("git", ["init", "-q"], { cwd: b })
    expect(resolveProject(a).id).not.toBe(resolveProject(b).id)
    rmSync(a, { recursive: true, force: true })
    rmSync(b, { recursive: true, force: true })
  })
})

/**
 * The memoization guarantee is the whole point of the service map. Effect's
 * RcMap compares keys by Equal/Hash, so keying on a plain object would rebuild
 * every graph on every lookup while still passing a naive "it returns services"
 * test. These count actual construction.
 */
describe("LayerMap memoization", () => {
  test("builds one graph per distinct key and reuses it", async () => {
    let built = 0
    class Counter extends Context.Service<Counter, { readonly value: number }>()("test/Counter") {}

    const built_ = await Effect.runPromise(
      Effect.gen(function* () {
        const map = yield* LayerMap.make(
          (k: string) =>
            Layer.sync(Counter, () => {
              built++
              return Counter.of({ value: k.length })
            }),
          { idleTimeToLive: "60 minutes" },
        )
        yield* Effect.provide(Effect.void, map.get("/a"))
        yield* Effect.provide(Effect.void, map.get("/a"))
        yield* Effect.provide(Effect.void, map.get("/b"))
        return built
      }).pipe(Effect.scoped),
    )

    expect(built_).toBe(2)
  })
})

describe("LocationServiceMap", () => {
  test("resolves Location for a directory", async () => {
    const dir = scratch()
    const info = await run(
      Effect.gen(function* () {
        return yield* Effect.provide(Location, at({ directory: dir }))
      }),
    )
    expect(info.directory).toBe(dir)
    expect(info.project.id.startsWith("prj_")).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  test("gives two directories independent tool registries", async () => {
    const a = scratch()
    const b = scratch()
    const same = await run(
      Effect.gen(function* () {
        const one = yield* Effect.provide(ToolRegistry, at({ directory: a }))
        const two = yield* Effect.provide(ToolRegistry, at({ directory: b }))
        return one === two
      }),
    )
    expect(same).toBe(false)
    rmSync(a, { recursive: true, force: true })
    rmSync(b, { recursive: true, force: true })
  })

  test("reuses one graph for repeated lookups of the same Location", async () => {
    const dir = scratch()
    const same = await run(
      Effect.gen(function* () {
        const one = yield* Effect.provide(SessionRun, at({ directory: dir }))
        const two = yield* Effect.provide(SessionRun, at({ directory: dir }))
        return one === two
      }),
    )
    expect(same).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  test("shares the global session store across Locations", async () => {
    const a = scratch()
    const b = scratch()
    const shared = await run(
      Effect.gen(function* () {
        // SessionStore is global, so it is reachable without entering a Location
        // at all, and a session created under one directory is visible from
        // another. Only the registry and runner are per-Location.
        const store = yield* SessionStore
        const created = yield* store.create({ title: "shared", directory: a })

        const fromA = yield* Effect.provide(
          Effect.gen(function* () {
            yield* Location
            return yield* store.get(created.id)
          }),
          at({ directory: a }),
        )
        const fromB = yield* Effect.provide(
          Effect.gen(function* () {
            yield* Location
            return yield* store.get(created.id)
          }),
          at({ directory: b }),
        )
        return fromA.id === created.id && fromB.id === created.id
      }),
    )
    expect(shared).toBe(true)
    rmSync(a, { recursive: true, force: true })
    rmSync(b, { recursive: true, force: true })
  })
})
