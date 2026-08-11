import type { NationId } from "../worldgen/nation";

export type WarIntentRoute = "land" | "maritime";
export type WarIntentReason =
  | "opportunistic-expansion"
  | "threat-response"
  | "strategic-port"
  | "maritime-expansion"
  | "balance-of-power"
  | "weakened-enemy";
export type WarIntentRejectionReason =
  | "external-threat"
  | "common-threat-coalition"
  | "overextended"
  | "insufficient-strength"
  | "maritime-infeasible"
  | "capital-emergency"
  | "strategic-value-low"
  | "below-threshold";

export interface WarIntentAssessment {
  aggressorId: NationId;
  targetNationId: NationId;
  route: WarIntentRoute;
  score: number;
  opportunity: number;
  threatResponse: number;
  strategicValue: number;
  expectedCost: number;
  existingCommitment: number;
  externalExposure: number;
  dominantReason: WarIntentReason;
  rejectedReasons: WarIntentRejectionReason[];
  aboveThreshold: boolean;
  declared: boolean;
  evaluatedAtTick: number;
}

export interface WarIntentState {
  assessments: WarIntentAssessment[];
  assessmentsByNationId: Map<NationId, WarIntentAssessment[]>;
  version: number;
  candidateEvaluations: number;
  landCandidates: number;
  maritimeCandidates: number;
  intentsAboveThreshold: number;
  declarations: number;
  declarationsByReason: Record<WarIntentReason, number>;
  suppressedDeclarations: number;
  suppressionByExternalThreat: number;
  suppressionByExistingWars: number;
  suppressionByCapitalEmergency: number;
  maritimeDeclarations: number;
  totalIntent: number;
  totalOpportunity: number;
  totalThreatResponse: number;
  totalExpectedCost: number;
  totalExternalExposure: number;
  rankingChanges: number;
  evaluationCpuMs: number;
  thirdPartyOpportunisticInvasions: number;
  warsAgainstAlreadyFightingNations: number;
  multiWarStarts: number;
  declarationsAgainstTopThreat: number;
  declarationsAgainstWeakerNonThreatTargets: number;
}

export function createWarIntentState(): WarIntentState {
  return {
    assessments: [], assessmentsByNationId: new Map(), version: 0,
    candidateEvaluations: 0, landCandidates: 0, maritimeCandidates: 0,
    intentsAboveThreshold: 0, declarations: 0,
    declarationsByReason: {
      "opportunistic-expansion": 0, "threat-response": 0, "strategic-port": 0,
      "maritime-expansion": 0, "balance-of-power": 0, "weakened-enemy": 0,
    },
    suppressedDeclarations: 0, suppressionByExternalThreat: 0,
    suppressionByExistingWars: 0, suppressionByCapitalEmergency: 0,
    maritimeDeclarations: 0, totalIntent: 0, totalOpportunity: 0,
    totalThreatResponse: 0, totalExpectedCost: 0, totalExternalExposure: 0,
    rankingChanges: 0, evaluationCpuMs: 0,
    thirdPartyOpportunisticInvasions: 0, warsAgainstAlreadyFightingNations: 0,
    multiWarStarts: 0, declarationsAgainstTopThreat: 0,
    declarationsAgainstWeakerNonThreatTargets: 0,
  };
}
