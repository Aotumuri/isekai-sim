import type { StrategicResource } from "../data/strategic-resources";
import type { NationResources } from "./nation-runtime";
import type { EquipmentFamily } from "./research";

type PrototypeMaterial = StrategicResource | "fuel";
export const PROTOTYPE_MATERIAL_RATES: Record<EquipmentFamily, Partial<Record<PrototypeMaterial, number>>> = {
  Infantry: { copper: 0.25 },
  Tank: { fuel: 0.3, rubber: 0.3, tungsten: 0.25 },
  CombatShip: { fuel: 0.25, copper: 0.3, tungsten: 0.3 },
  TransportShip: { fuel: 0.2, copper: 0.2, rubber: 0.25 },
};

export function getPrototypeMaterialRates(resources: NationResources, family: EquipmentFamily): [PrototypeMaterial, number][] {
  return (Object.entries(PROTOTYPE_MATERIAL_RATES[family]) as [PrototypeMaterial, number][])
    .filter(([resource]) => resource === "fuel" || resources[resource] !== undefined);
}
