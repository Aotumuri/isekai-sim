import { relationKey } from "../../src/sim/diplomacy";
import { isNationActive } from "../../src/sim/nation-active";
import type { SimulationEvent } from "../../src/sim/simulation-settings";
import { getAdjacentNationPairs, getPortTargetsByNation } from "../../src/sim/world-cache";
import type { WorldState } from "../../src/sim/world-state";
import type { NationId } from "../../src/worldgen/nation";

export function observePeaceFollowthrough(world: WorldState) {
  const pairs = new Map<string, [NationId, NationId]>();
  const samples: ReturnType<typeof snapshotCycle>[] = [];
  const events: SimulationEvent[] = [];

  function track(a: NationId, b: NationId) {
    if (a !== b) pairs.set(relationKey(a, b), [a, b]);
  }

  function recordEvent(event: SimulationEvent) {
    if (event.category === "aid" || /signed peace \(|proposed peace to |revised its peace terms|in reparations to |funded the restart of industry/.test(event.message)) {
      events.push({ ...event, nationIds: [...event.nationIds] });
    }
  }

  function snapshotCycle() {
    const { fastTick: day, slowTick } = world.time;
    const wars = world.wars.map(({ id, aggressorId, defenderId, cause, startedAtFastTick }) =>
      ({ id, aggressorId, defenderId, cause, startedAtFastTick }));
    const reparations = world.resourceReparations ?? [];
    const negotiations = [...world.warNegotiations?.active.values() ?? []];
    const settlements = (world.warNegotiations?.settlements ?? []).filter(({ atSlowTick }) => atSlowTick === slowTick);
    const subjects = world.nations.filter(({ subjectGovernment }) => subjectGovernment);
    const subjectById = new Map(subjects.map(nation => [nation.id, nation.subjectGovernment!]));
    for (const { a, b } of settlements) track(a, b);
    for (const { payerId, recipientId } of reparations) track(payerId, recipientId);
    for (const nation of subjects) track(nation.id, nation.subjectGovernment!.overlordId);
    for (const { aggressorId, defenderId } of wars) {
      track(aggressorId, defenderId);
      const subject = subjectById.get(defenderId);
      if (subject) track(aggressorId, subject.overlordId);
    }
    const borders = new Set(getAdjacentNationPairs(world).map(([a, b]) => relationKey(a, b)));
    const ports = getPortTargetsByNation(world);
    const relations = [...pairs].map(([key, [a, b]]) => {
      const relation = world.diplomacy?.relations.get(key);
      return { a, b, adjacent: borders.has(key), ports: [ports.get(a)?.length ?? 0, ports.get(b)?.length ?? 0],
        trust: relation?.trust, grievance: relation?.grievance, treaties: relation?.treaties, defensePact: relation?.defensePact };
    });
    const tracked = new Set([...pairs.values()].flat());
    const nations = world.nations.filter(({ id }) => tracked.has(id)).map(nation => ({
      id: nation.id, active: isNationActive(nation), subject: nation.subjectGovernment, credit: nation.treatyCredibility,
      stocks: nation.resources, cash: nation.treasury?.balance, ideologyId: nation.politics?.governingIdeologyId ?? nation.ideologyId,
    }));
    return structuredClone({
      day, wars, relations, nations, settlements, reparations, recovery: [...world.industrialRecovery ?? []],
      negotiations: negotiations.map(({ key, a, b, outlook, offers }) => ({ key, a, b, outlook, offers: [...offers.values()] })),
      defensiveInterventions: world.diplomacy?.defensiveInterventions ?? 0,
    });
  }

  return { recordEvent, sampleCycle: () => samples.push(snapshotCycle()), samples, events };
}
