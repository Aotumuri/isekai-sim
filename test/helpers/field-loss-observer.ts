import type { WorldState } from "../../src/sim/world-state";

interface FieldSnapshot { nationId: string; manpower: number }
export interface FieldLoss {
  survivorManpowerDamage: number;
  manpowerOnRemovedFormations: number;
  formationsRemoved: number;
}

/** Diagnostic-only observation between repositioning and the end of battle.
 * Includes amphibious losses in that interval. Peace and slow-tick deliberate
 * demobilization happen outside it and are not called battlefield losses. */
export function createFieldLossObserver() {
  let before = new Map<string, FieldSnapshot>();
  const byNationId = new Map<string, FieldLoss>();
  const capture = (world: WorldState) => {
    const result = new Map<string, FieldSnapshot>();
    const visit = (unit: WorldState["units"][number]) => {
      if (result.has(unit.id)) return;
      result.set(unit.id, { nationId: unit.nationId, manpower: unit.manpower });
      for (const cargo of unit.cargoUnits) visit(cargo);
    };
    for (const unit of world.units) visit(unit);
    for (const mission of world.volunteers?.missions ?? []) for (const unit of mission.transitUnits) visit(unit);
    return result;
  };
  return {
    before(world: WorldState) { before = capture(world); },
    after(world: WorldState) {
      const after = capture(world);
      for (const [id, previous] of before) {
        let cost = byNationId.get(previous.nationId);
        if (!cost) {
          cost = { survivorManpowerDamage: 0, manpowerOnRemovedFormations: 0, formationsRemoved: 0 };
          byNationId.set(previous.nationId, cost);
        }
        const current = after.get(id);
        if (!current) {
          cost.manpowerOnRemovedFormations += Math.max(0, previous.manpower);
          cost.formationsRemoved++;
        } else if (current.nationId === previous.nationId) {
          cost.survivorManpowerDamage += Math.max(0, previous.manpower - current.manpower);
        }
      }
      before = new Map();
    },
    result() { return Object.fromEntries([...byNationId].map(([id, cost]) => [id, { ...cost,
      unavailableManpower: cost.survivorManpowerDamage + cost.manpowerOnRemovedFormations }])); },
  };
}
