import type { NationId } from "../worldgen/nation";
import type { WorldState } from "./world-state";
import { getNationIdeology } from "./nation-identity";

/** Fictional-world affinities: differences create friction, never a treaty prohibition. */
export function ideologyCompatibility(a: string, b: string): number {
  if (a === b) return 1;
  const pair = [a, b].sort().join(":");
  if (pair === "capitalism:communism") return -1;
  if (a === "avian-supremacy" || b === "avian-supremacy") return -0.65;
  if (a === "cohesionism" || b === "cohesionism") return -0.35;
  return -0.25;
}
export function getIdeologicalAffinity(world: WorldState, a: NationId, b: NationId): number {
  return ideologyCompatibility(getNationIdeology(world, a).id, getNationIdeology(world, b).id);
}
export function ideologyAffinityLabel(affinity: number): string {
  return affinity >= 0.75 ? "近い" : affinity <= -0.75 ? "対立" : affinity <= -0.5 ? "相いれない" : "異なる";
}
