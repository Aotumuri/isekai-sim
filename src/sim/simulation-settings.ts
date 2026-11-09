import { getNationName } from "./nation-identity";
import type { NationId } from "../worldgen/nation";
import type { WorldState } from "./world-state";

export interface SimulationSettings {
  mobilizationEnabled: boolean;
  diplomacyEnabled: boolean;
  legacyWarDeclarationsEnabled: boolean;
  researchEnabled: boolean;
  armsAidEnabled: boolean;
  tradeEnabled: boolean;
  foodEnabled?: boolean;
  politicalTurbulenceEnabled?: boolean;
}

export function createSimulationSettings(overrides: Partial<SimulationSettings> = {}): SimulationSettings {
  return { mobilizationEnabled: true, diplomacyEnabled: true, legacyWarDeclarationsEnabled: true,
    researchEnabled: true, armsAidEnabled: true, tradeEnabled: true, foodEnabled: true, ...overrides };
}

export function getWarDeclarationMode(world: WorldState): "diplomacy" | "legacy" | "off" {
  // Hand-authored older worlds retain their original behavior.
  if (!world.settings) return "legacy";
  if (world.settings.diplomacyEnabled) return "diplomacy";
  return world.settings.legacyWarDeclarationsEnabled ? "legacy" : "off";
}

export interface SimulationEvent {
  tick: number;
  category: "diplomacy" | "research" | "aid" | "trade" | "military" | "politics";
  nationIds: string[];
  message: string;
}

export function hasPoliticalTurbulence(world: WorldState): boolean {
  return world.settings?.politicalTurbulenceEnabled === true && getWarDeclarationMode(world) === "diplomacy";
}

export function recordSimulationEvent(world: WorldState, event: Omit<SimulationEvent, "tick">): void {
  const events = world.events ??= [];
  const names = new Map(world.nations.map((nation) => [nation.id as string, getNationName(world, nation.id)]));
  const message = event.message.replace(/nation-[a-zA-Z0-9-]+/g, (id) => names.get(id) ?? getNationName(world, id as NationId));
  events.push({ ...event, message, tick: world.time.fastTick });
  if (events.length > 200) events.splice(0, events.length - 200);
}
