import type { SubjectDecision } from "./subject-negotiations";
import type { IdentityGovernment, IdentityGroup } from "./identity-policy";
import type { NationalIdentityStability } from "./identity-grievances";
import type { TheaterCommander } from "./theater-command";
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
  /** Domestic output less production and upkeep, before trade and treaty transfers. */
  productionSurplus?: Partial<NationResources>;
  industry?: {
    output: NationResources;
    fuelDemand: number;
    fuelConsumed: number;
    weaponsForRecruitment: number;
    weaponDemandAverage: number;
    weaponsTarget: number;
    prototypeFuelReserve: number;
    researchDemand?: Partial<NationResources>;
  };
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
  treatyCredibility?: { risk: number; lastIncidentAt: number };
  food?: NationalFoodSupply;
  treasury?: NationalTreasury;
  displacementOrder?: DisplacementOrder;
  nextDisplacementOrderAt?: number;
  /** Legacy diplomatic program and official title. Treatment is stored separately. */
  populationPolicy?: PopulationPolicy;
  identityGovernment?: IdentityGovernment;
  identityStability?: NationalIdentityStability;
  religiousBan?: { allowedFaith: number; until: number; lastAppliedAt?: number };
  nextReligiousBanAt?: number;
  nationalistMovement?: { targetId: Nation["id"]; group: number; until: number; nextAt: number };
  governance?: {
    policy: "centralized" | "autonomy" | "assimilation";
    stability: number;
    diversity: number;
    alignment: number;
    alignmentCulture?: IdentityGroup<"culture">;
    since: number;
    autonomyLostAt?: number;
  };
  character?: NationCharacter;
  preGovernmentCharacter?: NationCharacter;
  politics?: NationalPolitics;
  theaterCommander?: TheaterCommander;
  subjectDecision?: SubjectDecision;
  subjectGovernment?: SubjectGovernment;
  integratedIntoId?: Nation["id"];
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
