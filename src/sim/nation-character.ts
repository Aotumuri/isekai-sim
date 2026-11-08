import type { NationId } from "../worldgen/nation";
import type { WorldState } from "./world-state";

export type NationalDoctrine = "expansionist" | "merchant" | "technocrat" | "guardian" | "pragmatist" | "isolationist";
export interface NationCharacter {
  doctrine: NationalDoctrine;
  aggression: number;
  cooperation: number;
  innovation: number;
  thrift: number;
}

const PROFILES: readonly NationCharacter[] = [
  { doctrine: "expansionist", aggression: 0.9, cooperation: 0.3, innovation: 0.5, thrift: 0.3 },
  { doctrine: "merchant", aggression: 0.25, cooperation: 0.9, innovation: 0.5, thrift: 0.85 },
  { doctrine: "technocrat", aggression: 0.4, cooperation: 0.6, innovation: 0.95, thrift: 0.4 },
  { doctrine: "guardian", aggression: 0.35, cooperation: 0.8, innovation: 0.55, thrift: 0.5 },
  { doctrine: "pragmatist", aggression: 0.6, cooperation: 0.55, innovation: 0.6, thrift: 0.8 },
  { doctrine: "isolationist", aggression: 0.15, cooperation: 0.25, innovation: 0.65, thrift: 0.7 },
];

/** Stable across iteration order; does not consume the simulation RNG. */
export function getNationCharacter(world: WorldState, nationId: NationId): NationCharacter {
  const nation = world.nations.find((item) => item.id === nationId);
  if (nation?.character) return nation.character;
  let hash = 2166136261;
  for (const char of `${world.worldSeed ?? 0}:${nationId}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  const profile = { ...PROFILES[(hash >>> 0) % PROFILES.length] };
  if (nation) nation.character = profile;
  return profile;
}
