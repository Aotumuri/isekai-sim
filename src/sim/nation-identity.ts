import { populationPolicyTitle } from "./population-politics";
import type { NationId } from "../worldgen/nation";
import type { WorldState } from "./world-state";

export interface Ideology { id: string; name: string }
export const BUILTIN_IDEOLOGIES: readonly Ideology[] = [
  { id: "communism", name: "Communism" }, { id: "capitalism", name: "Capitalism" },
  { id: "cohesionism", name: "Cohesionism" }, { id: "avian-supremacy", name: "Avian Supremacy" },
];
const PREFIXES = [
  "Aster", "Val", "Nor", "Eld", "Cal", "Syl", "Raven", "Sol", "Mer", "Vel", "Arden", "Lun", "Cor", "Thal", "Iver", "Or", "Bran", "Zeph", "Dun", "Fen", "Kest", "Hal", "Tir", "Wyn",
  "Bel", "Caer", "Dor", "Es", "Fael", "Glen", "Hel", "Isen", "Jor", "Kael", "Lor", "Mar", "Nim", "Ost", "Pyr", "Quel", "Riv", "Sar", "Tor", "Ul", "Vard", "West", "Xan", "Yor", "Zar", "Ash", "Bryn", "Cyr", "Drae", "Eir", "Frost", "Gal", "High", "Il", "Jun", "Kel", "Myr", "Oak", "Rhos", "Ser",
];
const SUFFIXES = [
  "ia", "oria", "mark", "mere", "land", "vale", "heim", "ara", "en", "ria", "holm", "essa", "or", "crest", "wyn", "fall", "gard", "haven", "dell", "mont", "reach", "ath", "ond", "is",
  "acia", "adia", "ael", "amar", "anor", "antis", "aris", "asar", "aven", "bridge", "brook", "cairn", "dale", "dor", "drin", "eria", "ford", "gate", "glen", "gora", "hall", "harbor", "marsh", "hold", "hollow", "ith", "keep", "len", "moor", "nar", "ora", "port", "rim", "ross", "stead", "stone", "terra", "thorn", "tor", "watch",
];
const MIDDLE_SYLLABLES = ["an", "el", "ir", "ol", "un", "ar", "en", "is", "or", "ur", "al", "er", "in", "os", "ul", "ath"];
function middleSyllables(index: number): string {
  let result = "";
  while (index > 0) {
    index--;
    result = MIDDLE_SYLLABLES[index % MIDDLE_SYLLABLES.length]! + result;
    index = Math.floor(index / MIDDLE_SYLLABLES.length);
  }
  return result;
}
function greatestCommonDivisor(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}
function chooseNationName(hash: number, used: ReadonlySet<string>): string {
  const count = PREFIXES.length * SUFFIXES.length;
  const start = (hash % PREFIXES.length) * SUFFIXES.length + (hash >>> 8) % SUFFIXES.length;
  let step = ((hash >>> 16) | 1) % count;
  // A coprime stride visits every combination before expanding the name grammar.
  while (greatestCommonDivisor(step, count) !== 1) step++;
  for (let variation = 0; ; variation++) {
    const middle = middleSyllables(variation);
    for (let attempt = 0; attempt < count; attempt++) {
      const index = (start + attempt * step) % count;
      const name = `${PREFIXES[Math.floor(index / SUFFIXES.length)]}${middle}${SUFFIXES[index % SUFFIXES.length]}`;
      if (!used.has(name.toLowerCase())) return name;
    }
  }
}
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
  const used = new Set(world.nations.filter((nation) => nation.name).map((nation) => nation.name!.toLowerCase()));
  for (const nation of [...world.nations].sort((a, b) => a.id.localeCompare(b.id))) {
    const hash = identityHash(`${world.worldSeed ?? 0}:${nation.id}:identity`);
    if (!nation.name) {
      const name = chooseNationName(hash, used);
      nation.name = name; used.add(name.toLowerCase());
    }
    nation.ideologyId ??= BUILTIN_IDEOLOGIES[(hash >>> 16) % BUILTIN_IDEOLOGIES.length]!.id;
  }
}
export function getNationName(world: WorldState, nationId: NationId, form: "official" | "short" = "official"): string {
  const nation = world.nations.find((item) => item.id === nationId);
  if (nation && !nation.name) assignNationIdentities(world);
  if (form === "official" && nation?.populationPolicy) return `${nation.name} · ${populationPolicyTitle(nation.populationPolicy)}`;
  return nation?.name ?? "Unknown nation";
}
export function getNationIdeology(world: WorldState, nationId: NationId): Ideology {
  const nation = world.nations.find((item) => item.id === nationId);
  if (nation && !nation.ideologyId) assignNationIdentities(world);
  return getIdeologies(world).find((item) => item.id === nation?.ideologyId) ?? BUILTIN_IDEOLOGIES[0]!;
}
