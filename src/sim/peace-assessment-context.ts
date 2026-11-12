import type { NationId } from "../worldgen/nation";
import type { MesoRegionId } from "../worldgen/meso-region";
import type { WarState } from "./war-state";

/** One immutable evaluation pass only. Never retain this across ticks, offers,
 * player actions or campaign adoption. Formulas stay in the peace evaluator. */
export interface PeaceAssessmentContext {
  power: Map<NationId, number>;
  advantage: Map<string, number>;
  urgency: Map<NationId, number>;
  competingPressure: Map<string, number>;
  territorialValue: Map<NationId, number>;
  occupied: Map<string, MesoRegionId[]>;
  settlementReady: Map<WarState, boolean>;
  borderIssue: Map<string, string | null>;
}

export function createPeaceAssessmentContext(): PeaceAssessmentContext {
  return { power: new Map(), advantage: new Map(), urgency: new Map(),
    competingPressure: new Map(), territorialValue: new Map(), occupied: new Map(), settlementReady: new Map(),
    borderIssue: new Map() };
}

export function readPeaceAssessmentFact<K, V>(cache: Map<K, V> | undefined, key: K, compute: () => V): V {
  if (cache?.has(key)) return cache.get(key)!;
  const value = compute();
  cache?.set(key, value);
  return value;
}
