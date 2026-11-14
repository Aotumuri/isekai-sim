import type { NationId } from "../../src/worldgen/nation";
import type { MesoRegionId } from "../../src/worldgen/meso-region";
import type { WarState } from "../../src/sim/war-state";
import type { WorldState } from "../../src/sim/world-state";

type GovernmentStatus = "independent" | "subject" | "exiled" | "eliminated";
interface GovernmentState { status: GovernmentStatus; overlordId: NationId | null; capitalLegallyOwned: boolean }

/** Common diagnostic outcome, independent of any engine's campaign labels.
 * Territorial survival alone must not count subjection as preserved autonomy. */
export function createOpeningGovernmentObserver(world: WorldState, wars: readonly WarState[]) {
  let territoryVersion = -1;
  let owners = new Map<MesoRegionId, NationId>();
  refreshOwners(world);
  const tracked = wars.flatMap((war) => [war.nationAId, war.nationBId].map((nationId) => {
    const opening = governmentState(world, nationId);
    return { war, outcome: { nationId, opponentId: war.nationAId === nationId ? war.nationBId : war.nationAId,
      aggressor: nationId === war.aggressorId, startedAtTick: war.startedAtFastTick,
      openingStatus: opening.status, openingOverlordId: opening.overlordId,
      observedAtTick: world.time.fastTick, endedAtTick: null as number | null,
      ...opening, governmentPreserved: false, opponentSubjectToUs: false } };
  }));
  return { result: () => tracked.map(({ outcome }) => ({ ...outcome })), currentStates(current: WorldState) {
    refreshOwners(current);
    return [...new Set(tracked.map(({ outcome }) => outcome.nationId))].map((nationId) => {
      const state = governmentState(current, nationId);
      const opening = tracked.find(({ outcome }) => outcome.nationId === nationId)!.outcome;
      return { nationId, ...state, governmentPreserved: state.capitalLegallyOwned &&
        (state.status === "independent" || state.status === "subject" && state.overlordId === opening.openingOverlordId) };
    });
  }, observe(current: WorldState) {
    refreshOwners(current);
    const present = new Set(current.wars);
    for (const { war, outcome } of tracked) {
      if (outcome.endedAtTick !== null) continue;
      const now = governmentState(current, outcome.nationId);
      Object.assign(outcome, now);
      outcome.observedAtTick = current.time.fastTick;
      outcome.governmentPreserved = now.capitalLegallyOwned &&
        (now.status === "independent" || now.status === "subject" && now.overlordId === outcome.openingOverlordId);
      outcome.opponentSubjectToUs = governmentState(current, outcome.opponentId).overlordId === outcome.nationId;
      if (!present.has(war)) outcome.endedAtTick = current.time.fastTick;
    }
  } };

  function refreshOwners(current: WorldState): void {
    if (territoryVersion === current.territoryVersion) return;
    territoryVersion = current.territoryVersion;
    owners = new Map();
    for (const macro of current.macroRegions) if (macro.nationId) {
      for (const id of macro.mesoRegionIds) owners.set(id, macro.nationId);
    }
  }

  function governmentState(current: WorldState, id: NationId): GovernmentState {
    const nation = current.nations.find((item) => item.id === id);
    if (!nation?.macroRegionIds.length) return { status: current.exileGovernments?.byNationId.get(id)?.status === "exiled"
      ? "exiled" : "eliminated", overlordId: null, capitalLegallyOwned: false };
    const parent = nation.subjectGovernment?.overlordId;
    const overlordId = parent && current.nations.some((item) => item.id === parent && item.macroRegionIds.length) ? parent : null;
    return { status: overlordId ? "subject" : "independent", overlordId,
      capitalLegallyOwned: owners.get(nation.capitalMesoId) === id };
  }
}
