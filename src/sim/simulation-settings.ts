import type { WorldState } from "./world-state";

export interface SimulationSettings {
  diplomacyEnabled: boolean;
  legacyWarDeclarationsEnabled: boolean;
  researchEnabled: boolean;
  armsAidEnabled: boolean;
  tradeEnabled: boolean;
}

export function createSimulationSettings(overrides: Partial<SimulationSettings> = {}): SimulationSettings {
  return { diplomacyEnabled: true, legacyWarDeclarationsEnabled: true,
    researchEnabled: true, armsAidEnabled: true, tradeEnabled: true, ...overrides };
}

export function getWarDeclarationMode(world: WorldState): "diplomacy" | "legacy" | "off" {
  // Hand-authored older worlds retain their original behavior.
  if (!world.settings) return "legacy";
  if (world.settings.diplomacyEnabled) return "diplomacy";
  return world.settings.legacyWarDeclarationsEnabled ? "legacy" : "off";
}

export interface SimulationEvent {
  tick: number;
  category: "diplomacy" | "research" | "aid" | "trade";
  nationIds: string[];
  message: string;
}

export function recordSimulationEvent(world: WorldState, event: Omit<SimulationEvent, "tick">): void {
  const events = world.events ??= [];
  events.push({ ...event, tick: world.time.fastTick });
  if (events.length > 200) events.splice(0, events.length - 200);
}
