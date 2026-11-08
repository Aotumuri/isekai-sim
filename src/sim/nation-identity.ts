import type { NationId } from "../worldgen/nation";
import type { WorldState } from "./world-state";

export interface Ideology { id: string; name: string }
export const BUILTIN_IDEOLOGIES: readonly Ideology[] = [
  { id: "communism", name: "Communism" }, { id: "capitalism", name: "Capitalism" },
  { id: "cohesionism", name: "Cohesionism" }, { id: "avian-supremacy", name: "Avian Supremacy" },
];
const PREFIXES = ["Aster", "Val", "Nor", "Eld", "Cal", "Syl", "Raven", "Sol", "Mer", "Vel", "Arden", "Lun", "Cor", "Thal", "Iver", "Or", "Bran", "Zeph", "Dun", "Fen", "Kest", "Hal", "Tir", "Wyn"];
const SUFFIXES = ["ia", "oria", "mark", "mere", "land", "vale", "heim", "ara", "en", "ria", "holm", "essa", "or", "crest", "wyn", "fall", "gard", "haven", "dell", "mont", "reach", "ath", "ond", "is"];
export function identityHash(value: string): number {
  let hash = 2166136261;
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}
export function getIdeologies(world: WorldState): readonly Ideology[] { return [...BUILTIN_IDEOLOGIES, ...(world.customIdeologies ?? [])]; }
export function createIdeology(world: WorldState, name: string): Ideology | null {
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (trimmed.length < 3 || trimmed.length > 40 || (world.customIdeologies?.length ?? 0) >= 16 ||
    getIdeologies(world).some((item) => item.name.toLowerCase() === trimmed.toLowerCase())) return null;
  const ideology = { id: `custom-${identityHash(trimmed).toString(36)}`, name: trimmed };
  if (getIdeologies(world).some((item) => item.id === ideology.id)) return null;
  (world.customIdeologies ??= []).push(ideology);
  return ideology;
}
export function assignNationIdentities(world: WorldState): void {
  const used = new Set(world.nations.filter((nation) => nation.name).map((nation) => nation.name!));
  for (const nation of [...world.nations].sort((a, b) => a.id.localeCompare(b.id))) {
    const hash = identityHash(`${world.worldSeed ?? 0}:${nation.id}:identity`);
    if (!nation.name) {
      const base = `${PREFIXES[hash % PREFIXES.length]}${SUFFIXES[(hash >>> 8) % SUFFIXES.length]}`;
      let name = base, suffix = 2;
      while (used.has(name)) name = `${base} ${suffix++}`;
      nation.name = name; used.add(name);
    }
    nation.ideologyId ??= BUILTIN_IDEOLOGIES[(hash >>> 16) % BUILTIN_IDEOLOGIES.length]!.id;
  }
}
export function getNationName(world: WorldState, nationId: NationId): string {
  const nation = world.nations.find((item) => item.id === nationId);
  if (nation && !nation.name) assignNationIdentities(world);
  return nation?.name ?? "Unknown nation";
}
export function getNationIdeology(world: WorldState, nationId: NationId): Ideology {
  const nation = world.nations.find((item) => item.id === nationId);
  if (nation && !nation.ideologyId) assignNationIdentities(world);
  return getIdeologies(world).find((item) => item.id === nation?.ideologyId) ?? BUILTIN_IDEOLOGIES[0]!;
}
