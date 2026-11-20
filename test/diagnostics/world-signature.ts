import { createHash } from "node:crypto";
import type { WorldState } from "../../src/sim/world-state";

/** Compare simulation state across revisions on the same runtime. */
export function worldSignature(world: WorldState): string {
  const { cache, instrumentation, mapView, ...state } = world;
  const settings = state.settings && { ...state.settings };
  // Opting out of procurement can be compared with worlds from before the flag.
  if (settings) delete settings.economicPlanningEnabled;
  const omitTimings = (system: object) => Object.fromEntries(
    Object.entries(system).filter(([key]) => !key.endsWith("CpuMs")),
  );
  const snapshot = {
    ...state,
    ...(settings ? { settings } : {}),
    events: state.events?.slice(), // The history observer wraps push.
    amphibiousOperations: omitTimings(state.amphibiousOperations),
    strategicThreatObservation: omitTimings(state.strategicThreatObservation),
    warIntent: omitTimings(state.warIntent),
    supplyAssessment: {
      ...state.supplyAssessment,
      navalStrategy: omitTimings(state.supplyAssessment.navalStrategy),
      convoys: omitTimings(state.supplyAssessment.convoys),
      maritimeInterdiction: omitTimings(state.supplyAssessment.maritimeInterdiction),
    },
  };
  const seen = new Map<object, number>();
  const encoded = JSON.stringify(snapshot, (_key, value: unknown) => {
    // JSON uses round-trip representations for finite numbers other than -0.
    if (typeof value === "number" && (!Number.isFinite(value) || Object.is(value, -0))) {
      return { $number: Object.is(value, -0) ? "-0" : String(value) };
    }
    if (value === undefined) return { $undefined: true };
    if (value === null || typeof value !== "object") return value;
    const reference = seen.get(value);
    if (reference !== undefined) return { $ref: reference };
    seen.set(value, seen.size);
    // Preserve iteration order, repeated references, and the RNG's own state.
    if (value instanceof Map) return { $map: [...value.entries()] };
    if (value instanceof Set) return { $set: [...value] };
    return value;
  });
  return createHash("sha256").update(encoded).digest("hex");
}
