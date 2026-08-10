import type { MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import { getUnitCombatStrength } from "./unit-strength";
import type { FrontId } from "./land-fronts";
import type { SupplyComponentId } from "./supply-assessment";
import type { SupplyCutoffCandidate, SupplyCutoffSourceKind } from "./supply-cutoff";
import type { WorldState } from "./world-state";

export type SupplyCorridorRiskStatus = "safe" | "vulnerable" | "threatened" | "critical";
export type SupplyCorridorRiskReason =
  | "supply-corridor"
  | "supply-articulation"
  | "major-force-supply-risk"
  | "frontline-supply-risk"
  | "maritime-supply-entry-risk";

/** Defensive view of the shared Supply Cutoff prediction; it never re-walks connectivity. */
export interface SupplyCorridorRisk {
  key: string;
  nationId: NationId;
  attackerNationId: NationId;
  sectorId: FrontId;
  regionId: MesoRegionId;
  affectedComponentIds: SupplyComponentId[];
  affectedRegionIds: MesoRegionId[];
  threatenedStrength: number;
  threatenedUnits: number;
  threatenedRegions: number;
  threatenedCities: number;
  threatenedPorts: number;
  frontlineStrengthAffected: boolean;
  supplySourceType: SupplyCutoffSourceKind;
  currentDefenderStrength: number;
  requiredDefenseStrength: number;
  attackerStrength: number;
  riskScore: number;
  status: SupplyCorridorRiskStatus;
  reasonFlags: SupplyCorridorRiskReason[];
  evaluatedAtTick: number;
}

export interface SupplyDefenseState {
  risks: SupplyCorridorRisk[];
  risksByKey: Map<string, SupplyCorridorRisk>;
  risksByRegionNation: Map<string, SupplyCorridorRisk[]>;
  version: number;
  candidatesEvaluated: number;
  vulnerableCorridors: number;
  threatenedCorridors: number;
  criticalCorridors: number;
  reserveDeployments: number;
  strengthAssigned: number;
  predictedProtectedStrength: number;
  corridorsLost: number;
  predictedIsolation: number;
  actualIsolation: number;
  corridorsRestored: number;
  criticalStartedAtTickByKey: Map<string, number>;
  lostCorridorsByKey: Map<string, SupplyCorridorRisk>;
  lostAtTickByKey: Map<string, number>;
}

export function createSupplyDefenseState(): SupplyDefenseState {
  return {
    risks: [], risksByKey: new Map(), risksByRegionNation: new Map(), version: 0,
    candidatesEvaluated: 0, vulnerableCorridors: 0, threatenedCorridors: 0,
    criticalCorridors: 0, reserveDeployments: 0, strengthAssigned: 0,
    predictedProtectedStrength: 0, corridorsLost: 0, predictedIsolation: 0,
    actualIsolation: 0, corridorsRestored: 0, criticalStartedAtTickByKey: new Map(),
    lostCorridorsByKey: new Map(), lostAtTickByKey: new Map(),
  };
}

export function updateSupplyDefense(world: WorldState): void {
  const startedAt = world.instrumentation ? performance.now() : 0;
  const state = world.supplyDefense;
  const next = world.supplyCutoffs.candidates.map((candidate) => toRisk(world, candidate));
  state.candidatesEvaluated += world.supplyCutoffs.candidates.length;
  for (const prior of state.risks) {
    if (next.some((risk) => risk.key === prior.key)) continue;
    const owner = world.occupation.mesoById.get(prior.regionId);
    if (owner === prior.attackerNationId && !state.lostCorridorsByKey.has(prior.key)) {
      state.corridorsLost += 1;
      state.predictedIsolation += prior.threatenedStrength;
      const actual = actualIsolation(world, prior);
      state.actualIsolation += actual;
      state.lostCorridorsByKey.set(prior.key, prior);
      state.lostAtTickByKey.set(prior.key, world.time.fastTick);
      world.instrumentation?.incrementCounter("supplyDefense.corridorsLost");
      world.instrumentation?.incrementCounter("supplyDefense.predictedIsolation", prior.threatenedStrength);
      world.instrumentation?.incrementCounter("supplyDefense.actualIsolation", actual);
    } else if (owner === undefined && state.lostCorridorsByKey.has(prior.key)) {
      state.corridorsRestored += 1;
      const lostAt = state.lostAtTickByKey.get(prior.key) ?? world.time.fastTick;
      state.lostCorridorsByKey.delete(prior.key);
      state.lostAtTickByKey.delete(prior.key);
      world.instrumentation?.incrementCounter("supplyDefense.corridorsRestored");
      world.instrumentation?.incrementCounter("supplyDefense.lossToReconnectionTicks", world.time.fastTick - lostAt);
    }
  }
  for (const risk of next) {
    if (risk.status === "vulnerable") state.vulnerableCorridors += 1;
    if (risk.status === "threatened") state.threatenedCorridors += 1;
    if (risk.status === "critical") {
      state.criticalCorridors += 1;
      if (!state.criticalStartedAtTickByKey.has(risk.key)) {
        state.criticalStartedAtTickByKey.set(risk.key, world.time.fastTick);
      }
    } else state.criticalStartedAtTickByKey.delete(risk.key);
  }
  for (const [key, lost] of state.lostCorridorsByKey) {
    if (world.occupation.mesoById.get(lost.regionId) !== undefined) continue;
    state.corridorsRestored += 1;
    const lostAt = state.lostAtTickByKey.get(key) ?? world.time.fastTick;
    state.lostCorridorsByKey.delete(key);
    state.lostAtTickByKey.delete(key);
    world.instrumentation?.incrementCounter("supplyDefense.corridorsRestored");
    world.instrumentation?.incrementCounter("supplyDefense.lossToReconnectionTicks", world.time.fastTick - lostAt);
  }
  state.risks = next.sort((a, b) => b.riskScore - a.riskScore || compareIds(a.key, b.key));
  state.risksByKey = new Map(state.risks.map((risk) => [risk.key, risk]));
  state.risksByRegionNation = indexByRegionNation(state.risks);
  state.strengthAssigned = state.risks.reduce((sum, risk) => sum + Math.min(risk.currentDefenderStrength, risk.requiredDefenseStrength), 0);
  state.predictedProtectedStrength = state.risks.reduce((sum, risk) => sum + risk.threatenedStrength, 0);
  state.version += 1;
  if (world.instrumentation) {
    world.instrumentation.recordDuration("supplyDefense.analysis", performance.now() - startedAt);
    world.instrumentation.incrementCounter("supplyDefense.candidatesEvaluated", next.length);
    world.instrumentation.incrementCounter("supplyDefense.vulnerable", next.filter((risk) => risk.status === "vulnerable").length);
    world.instrumentation.incrementCounter("supplyDefense.threatened", next.filter((risk) => risk.status === "threatened").length);
    world.instrumentation.incrementCounter("supplyDefense.critical", next.filter((risk) => risk.status === "critical").length);
    world.instrumentation.incrementCounter("supplyDefense.strengthAssigned", Math.round(state.strengthAssigned));
    world.instrumentation.incrementCounter("supplyDefense.predictedProtectedStrength", Math.round(state.predictedProtectedStrength));
    world.instrumentation.incrementCounter("supplyDefense.defenseToProtectedRatioPermille", Math.round(
      1000 * state.strengthAssigned / Math.max(1, state.predictedProtectedStrength),
    ));
    world.instrumentation.incrementCounter("supplyDefense.operationStrengthWithheld", Math.round(
      state.risks.filter((risk) => risk.status === "threatened" || risk.status === "critical")
        .reduce((sum, risk) => sum + risk.requiredDefenseStrength, 0),
    ));
  }
}

export function getSupplyDefenseForFront(world: WorldState, nationId: NationId, sectorId: FrontId): readonly SupplyCorridorRisk[] {
  return world.supplyDefense.risks.filter((risk) => risk.nationId === nationId && risk.sectorId === sectorId);
}

export function getSupplyDefenseAtRegion(world: WorldState, nationId: NationId, regionId: MesoRegionId): readonly SupplyCorridorRisk[] {
  return world.supplyDefense.risksByRegionNation.get(`${nationId}::${regionId}`) ?? [];
}

function toRisk(world: WorldState, candidate: SupplyCutoffCandidate): SupplyCorridorRisk {
  const threatened = candidate.tacticalFeasibility || candidate.localAttackerStrength > candidate.localDefenderStrength * 0.7;
  // Never demand a static fortress: local enemy strength is the main input and
  // the protected force only contributes a bounded insurance margin.
  const requiredDefenseStrength = Math.max(0, Math.min(
    candidate.affectedStrength * 0.35,
    candidate.localAttackerStrength * 1.1 + candidate.affectedStrength * 0.1,
  ));
  const deficit = Math.max(0, requiredDefenseStrength - candidate.localDefenderStrength);
  const critical = threatened && (deficit >= Math.max(1, requiredDefenseStrength * 0.4) || candidate.majorForceAffected && deficit > 0);
  const status: SupplyCorridorRiskStatus = critical ? "critical" : threatened ? "threatened" : "vulnerable";
  const reasonFlags: SupplyCorridorRiskReason[] = ["supply-corridor", "supply-articulation"];
  if (candidate.majorForceAffected) reasonFlags.push("major-force-supply-risk");
  if (candidate.frontlineAffected) reasonFlags.push("frontline-supply-risk");
  if (candidate.sourceKind !== "capital-network" || candidate.affectedPorts > 0) reasonFlags.push("maritime-supply-entry-risk");
  return {
    key: `${candidate.enemyNationId}|${candidate.sectorId}|${candidate.targetRegionId}`,
    nationId: candidate.enemyNationId, attackerNationId: candidate.attackerNationId,
    sectorId: candidate.sectorId, regionId: candidate.targetRegionId,
    affectedComponentIds: [...candidate.affectedComponentIds], affectedRegionIds: [...candidate.affectedRegionIds],
    threatenedStrength: candidate.affectedStrength, threatenedUnits: candidate.affectedUnitCount,
    threatenedRegions: candidate.affectedRegionCount, threatenedCities: candidate.affectedCities,
    threatenedPorts: candidate.affectedPorts, frontlineStrengthAffected: candidate.frontlineAffected,
    supplySourceType: candidate.sourceKind, currentDefenderStrength: candidate.localDefenderStrength,
    requiredDefenseStrength, attackerStrength: candidate.localAttackerStrength,
    riskScore: candidate.score * (critical ? 1.35 : threatened ? 1 : 0.45), status, reasonFlags,
    evaluatedAtTick: world.time.fastTick,
  };
}

function actualIsolation(world: WorldState, risk: SupplyCorridorRisk): number {
  const expected = new Set(risk.affectedRegionIds);
  const supplied = world.supplyAssessment.assessmentByNationId.get(risk.nationId);
  const isolated = new Set((supplied?.components ?? []).filter((component) => component.isolated)
    .flatMap((component) => component.regionIds).filter((regionId) => expected.has(regionId)));
  return world.units.filter((unit) => unit.domain === "land" && unit.nationId === risk.nationId && isolated.has(unit.regionId))
    .reduce((sum, unit) => sum + getUnitCombatStrength(unit), 0);
}

function indexByRegionNation(risks: readonly SupplyCorridorRisk[]): Map<string, SupplyCorridorRisk[]> {
  const result = new Map<string, SupplyCorridorRisk[]>();
  for (const risk of risks) {
    const key = `${risk.nationId}::${risk.regionId}`;
    const list = result.get(key) ?? [];
    list.push(risk); result.set(key, list);
  }
  return result;
}
function compareIds(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
