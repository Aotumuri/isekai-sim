import { WORLD_BALANCE } from "../data/balance";
import { getCampaignDeadline } from "./campaign-deadline";
import type { OffensiveOperation } from "./offensive-operations";
import { FAST_TICK_MS, SLOW_TICK_MS } from "./time";
import { identityHash } from "./nation-identity";
import { getWarCampaign } from "./war-campaign/state";
import type { WorldState } from "./world-state";

export interface TheaterCommander {
  readonly id: string;
  readonly appointment: number;
  readonly appointedAtTick: number;
  readonly appointingIdeologyId?: string;
  readonly preference: "deliberate" | "prompt";
}

export interface TheaterLaunchDecision {
  readonly commanderId: string;
  readonly preference: TheaterCommander["preference"];
  readonly evaluatedAtTick: number;
  readonly readiness: number;
  readonly preferredReadiness: number;
  readonly outcome: "wait-for-assembly" | "proceed";
}

/** Called when an ordinary operation has otherwise met its existing launch gate. */
export function decideTheaterLaunch(
  world: WorldState, operation: OffensiveOperation, preparationTicks: number, readiness: number, minimumReadiness: number,
): TheaterLaunchDecision | undefined {
  const { nationId, enemyNationId } = operation;
  if (operation.theaterLaunchDecision || getWarCampaign(world, nationId)?.primaryOpponentId !== enemyNationId) return;
  const settings = WORLD_BALANCE.war.landFront.offensiveOperation;
  if (operation.isMajorOffensive || operation.supplyReliefPlanId || operation.supplyCutoffObjective ||
      operation.pocketClosureObjective || operation.pocketReductionObjective ||
      preparationTicks < settings.minimumPreparationTicks ||
      preparationTicks + SLOW_TICK_MS / FAST_TICK_MS > settings.preparationTimeoutTicks ||
      getCampaignDeadline(world, nationId, enemyNationId) <= 75) return;
  const player = world.playerNation;
  if (player?.nationId === nationId && (!player.automaticGovernment || player.commandMode !== "automatic")) return;
  const nation = world.nations.find((item) => item.id === nationId);
  if (!nation) return;

  const appointingIdeologyId = nation.politics?.governingIdeologyId ?? nation.ideologyId;
  let commander = nation.theaterCommander;
  if (!commander || commander.appointingIdeologyId !== appointingIdeologyId) {
    const appointment = (commander?.appointment ?? 0) + 1;
    const id = `${nationId}:theater:${appointment}`;
    const seed = identityHash(`${world.worldSeed ?? 0}:${id}`);
    commander = nation.theaterCommander = {
      id, appointment, appointedAtTick: world.time.fastTick, appointingIdeologyId,
      preference: seed % 2 === 0 ? "deliberate" : "prompt",
    };
  }
  const preferredReadiness = commander.preference === "deliberate" ? Math.min(1, minimumReadiness + 0.1) : minimumReadiness;
  return {
    commanderId: commander.id, preference: commander.preference, evaluatedAtTick: world.time.fastTick,
    readiness, preferredReadiness, outcome: readiness < preferredReadiness ? "wait-for-assembly" : "proceed",
  };
}
