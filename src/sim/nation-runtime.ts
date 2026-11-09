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

export interface NationResources {
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
  populationPolicy?: PopulationPolicy;
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
