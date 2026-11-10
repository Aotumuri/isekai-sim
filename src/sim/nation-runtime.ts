import type { DisplacementOrder } from "./forced-displacement";
import type { NationalFoodSupply } from "./food-supply";
import type { NationalTreasury } from "./treasury";
import type { PopulationPolicy } from "./population-politics";
import type { SubjectGovernment } from "./subject-governments";
import type { NationalPolitics } from "./politics";
import type { NationCharacter } from "./nation-character";
import type { Nation } from "../worldgen/nation";
import type { UnitId } from "./unit";

export interface NationUnitRoles {
  defenseUnitIds: UnitId[];
  occupationUnitIds: UnitId[];
}

export interface NationResources extends Partial<Record<import("../data/strategic-resources").StrategicResource, number>> {
  steel: number;
  fuel: number;
  manpower: number;
  weapons: number;
}

export interface NationResourceFlow {
  income: NationResources;
  usage: NationResources;
  delta: NationResources;
  lastTick: number;
}

export function createNationResources(): NationResources {
  return {
    steel: 0,
    fuel: 0,
    manpower: 0,
    weapons: 0,
  };
}

export function createNationResourceFlow(): NationResourceFlow {
  return {
    income: createNationResources(),
    usage: createNationResources(),
    delta: createNationResources(),
    lastTick: -1,
  };
}

export type NationRuntime = Nation & {
  food?: NationalFoodSupply;
  treasury?: NationalTreasury;
  displacementOrder?: DisplacementOrder;
  nextDisplacementOrderAt?: number;
  populationPolicy?: PopulationPolicy;
  religiousBan?: { allowedFaith: number; until: number; lastAppliedAt?: number };
  nextReligiousBanAt?: number;
  nationalistMovement?: { targetId: Nation["id"]; group: number; until: number; nextAt: number };
  governance?: {
    policy: "centralized" | "autonomy" | "assimilation";
    stability: number;
    diversity: number;
    alignment: number;
    since: number;
    manual?: boolean;
  };
  character?: NationCharacter;
  preGovernmentCharacter?: NationCharacter;
  politics?: NationalPolitics;
  subjectGovernment?: SubjectGovernment;
  unitRoles: NationUnitRoles;
  capitalFallCount: number;
  surrenderScore: number;
  initialUnitCount: number;
  initialCityCount: number;
  warCooperation: number;
  warCooperationBoost: number;
  nextUnitProductionTick: number;
  nextWarDeclarationTick: number;
  resources: NationResources;
  resourceFlow: NationResourceFlow;
};
