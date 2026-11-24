import type { WorldState } from "../../src/sim/world-state";
import { getOwnerByMesoId } from "../../src/sim/world-cache";
import { campaignWarKey, type WarCampaign } from "../../src/sim/war-campaign/state";
import { createCapitalFrontExecutionObserver } from "../helpers/capital-front-execution";
import { createOpeningGovernmentObserver } from "../helpers/war-government-outcome-observer";
import { createWarOutcomeObserver } from "./war-outcome-observer";

export function createCampaignBaselineObserver() {
  const outcomes = createWarOutcomeObserver();
  const governments = new Map<string, ReturnType<typeof createOpeningGovernmentObserver>>();
  const capitals = new Map<string, ReturnType<typeof createCapitalFrontExecutionObserver>>();
  const planSamples = new Map<string, ReturnType<typeof snapshotPlan>[]>();
  const decisions = new Map<string, ReturnType<typeof snapshotCommand>>();

  function observe(world: WorldState) {
    outcomes.observe(world);
    const activeNations = new Set(world.wars.flatMap((war) => [war.nationAId, war.nationBId]));
    for (const war of world.wars) {
      const key = campaignWarKey(war.nationAId, war.nationBId, war.startedAtFastTick);
      if (!governments.has(key)) governments.set(key, createOpeningGovernmentObserver(world, [war]));
    }
    for (const observer of governments.values()) observer.observe(world);

    for (const nation of world.nations) {
      if (!activeNations.has(nation.id) || !nation.macroRegionIds.length) continue;
      const key = JSON.stringify([nation.id, nation.capitalMesoId]);
      let capital = capitals.get(key);
      if (!capital) {
        capital = createCapitalFrontExecutionObserver(nation.id, nation.capitalMesoId);
        capitals.set(key, capital);
      }
      capital.observe(world);
    }

    for (const plan of world.warCampaigns?.byNationId.values() ?? []) {
      const samples = planSamples.get(plan.nationId) ?? [];
      const previous = samples.at(-1);
      if (previous?.evaluatedAtTick === plan.evaluatedAtTick && previous.revision === plan.revision) continue;
      samples.push(snapshotPlan(world, plan));
      planSamples.set(plan.nationId, samples);
    }
    for (const operation of world.offensiveOperations.operations) {
      const decision = operation.theaterLaunchDecision;
      if (!decision || decisions.has(operation.id)) continue;
      const plan = world.warCampaigns?.byNationId.get(operation.nationId);
      decisions.set(operation.id, snapshotCommand(world, operation, decision, plan));
    }
  }

  function result() {
    return {
      ...outcomes.result(),
      governments: [...governments.values()].flatMap((observer) => observer.result()),
      capitals: [...capitals.values()].map((observer) => observer.result()),
      planSamples: Object.fromEntries(planSamples),
      decisions: [...decisions.values()],
    };
  }

  return { observe, result };
}

type Operation = WorldState["offensiveOperations"]["operations"][number];

function snapshotCommand(world: WorldState, operation: Operation, decision: NonNullable<Operation["theaterLaunchDecision"]>,
  plan: WarCampaign | undefined) {
  return {
    operationId: operation.id, nationId: operation.nationId, opponentId: operation.enemyNationId,
    ...decision, sampledAtTick: world.time.fastTick, sampledNationalMode: plan?.mode ?? null,
    sampledNationalRevision: plan?.revision ?? null,
  };
}

function snapshotPlan(world: WorldState, plan: WarCampaign) {
  const owners = getOwnerByMesoId(world);
  const nation = world.nations.find(({ id }) => id === plan.nationId);
  return {
    tick: world.time.fastTick,
    evaluatedAtTick: plan.evaluatedAtTick, adoptedAtTick: plan.adoptedAtTick,
    revision: plan.revision, mode: plan.mode, militaryMode: plan.militaryMode, reason: plan.reason,
    primaryOpponentId: plan.primaryOpponentId, constraints: { ...plan.constraints },
    territoryVersion: world.territoryVersion, ideologyId: nation?.ideologyId ?? null,
    coalition: [...(nation?.politics?.coalition ?? [])],
    capitalId: nation?.capitalMesoId ?? null, fuelStock: nation?.resources.fuel ?? null,
    industrialFuelDemand: nation?.resourceFlow.industry?.fuelDemand ?? null,
    industrialFuelConsumed: nation?.resourceFlow.industry?.fuelConsumed ?? null,
    objectives: plan.objectives.map((goal) => ({
      warKey: goal.warKey, kind: goal.kind, opponentId: goal.opponentId, achieved: goal.achieved,
      rationale: goal.rationale, regionIds: [...goal.regionIds],
      legalOwners: goal.regionIds.map((id) => owners.get(id) ?? null),
    })),
  };
}
