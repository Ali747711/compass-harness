import { Context, Effect, Layer, LayerMap } from "effect"
import { Permission } from "../permission/permission"
import { Project } from "../project/project"
import { SessionInput } from "../session/input"
import { SessionRun, layer as runLayer } from "../session/run"
import { SessionStore } from "../session/store"
import { builtins } from "../tool/builtins"
import { ToolRegistry, layer as registryLayer } from "../tool/registry"
import { Location, key, layer as locationLayer, type LocationRef } from "./location"

/**
 * The services that are scoped to one Location. Everything here is rebuilt per
 * project or worktree; everything else (Database, Permission, SessionStore,
 * SessionInput) is global and shared across all of them — admitted prompts are
 * keyed by session, and a session belongs to exactly one Location already.
 */
export type LocationServices = Location | ToolRegistry | SessionRun

const services = (
  ref: LocationRef,
): Layer.Layer<LocationServices, never, Project | SessionStore | SessionInput | Permission> =>
  runLayer.pipe(Layer.provideMerge(registryLayer(builtins)), Layer.provideMerge(locationLayer(ref)))

export interface Interface {
  /** A Layer providing this Location's services. Memoized per Location. */
  readonly get: (ref: LocationRef) => Layer.Layer<LocationServices>
}

export class LocationServiceMap extends Context.Service<LocationServiceMap, Interface>()(
  "compass/LocationServiceMap",
) {}

/**
 * Builds and memoizes one service graph per Location.
 *
 * The per-Location layers require the global services, and `LayerMap.make`
 * hoists those requirements into the map's own construction. That is what makes
 * globals shared rather than rebuilt per Location — no separate hoisting pass
 * is needed.
 */
export const layer = Layer.effect(
  LocationServiceMap,
  Effect.gen(function* () {
    const map = yield* LayerMap.make((locationKey: string) => services(refFrom(locationKey)), {
      // Without this the RcMap finalizes an entry the moment its refcount hits
      // zero, so a second prompt to the same project rebuilds the entire graph.
      // opencode uses the same 60 minutes.
      idleTimeToLive: "60 minutes",
    })
    return LocationServiceMap.of({
      get: (ref) => map.get(key(ref)),
    })
  }),
)

/** Inverse of `key`. Kept local so the encoding stays in one place. */
function refFrom(value: string): LocationRef {
  const separator = value.indexOf(" ")
  if (separator === -1) return { directory: value }
  return { workspaceID: value.slice(0, separator) as LocationRef["workspaceID"], directory: value.slice(separator + 1) }
}

/** Convenience for running an effect inside one Location's services. */
export const at = (ref: LocationRef) => Layer.unwrap(Effect.map(LocationServiceMap, (locations) => locations.get(ref)))

export * as LocationServiceMapModule from "./service-map"
