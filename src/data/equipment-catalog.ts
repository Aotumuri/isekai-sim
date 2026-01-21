export const EQUIPMENT_CATALOG = {
  rifle_m1: {
    key: "rifle_m1",
    name: "M1 Rifle",
    kind: "infantry_weapon",
    cost: 1,
    softAttack: 2,
    hardAttack: 0,
  },
  rifle_m2: {
    key: "rifle_m2",
    name: "M2 Rifle",
    kind: "infantry_weapon",
    cost: 2,
    softAttack: 3,
    hardAttack: 1,
  },
} as const;

export type EquipmentKey = keyof typeof EQUIPMENT_CATALOG;
export type EquipmentDef = (typeof EQUIPMENT_CATALOG)[EquipmentKey];
export type EquipmentCatalog = typeof EQUIPMENT_CATALOG;
