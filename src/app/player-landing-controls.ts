import { cancelPlayerLanding, queuePlayerLanding } from "../sim/amphibious";
import { getPlayerNation } from "../sim/player-nation";
import type { WorldState } from "../sim/world-state";
import type { MesoRegionId } from "../worldgen/meso-region";

export function attachPlayerLandingControls(
  panel: HTMLElement, world: WorldState, getDestination: () => MesoRegionId | null,
): () => void {
  const section = document.createElement("details");
  section.innerHTML = `<summary>Landing plans</summary>
    <p>Select a friendly departure port on the map, set it as the departure point, then select an enemy port.</p>
    <button type="button" data-departure>Set selected district as departure port</button>
    <p data-ports></p>
    <label>Landing force size <input data-size type="number" min="1" step="1" value="1"></label>
    <label>Earliest launch tick <input data-tick type="number" min="0" step="1"></label>
    <p>You can schedule multiple plans for the same tick. Forces that are still preparing launch when ready.</p>
    <button type="button" data-queue>Schedule plan</button>
    <p role="status"></p>
    <ul></ul>`;
  panel.append(section);
  const tick = section.querySelector<HTMLInputElement>("[data-tick]")!;
  const size = section.querySelector<HTMLInputElement>("[data-size]")!;
  const ports = section.querySelector<HTMLElement>("[data-ports]")!;
  const result = section.querySelector<HTMLElement>("[role=status]")!;
  const list = section.querySelector("ul")!;
  let departure: MesoRegionId | null = null;
  let actor = getPlayerNation(world);
  let key = "";
  section.querySelector<HTMLButtonElement>("[data-departure]")!.onclick = () => {
    departure = getDestination();
  };
  section.querySelector<HTMLButtonElement>("[data-queue]")!.onclick = () => {
    const target = getDestination();
    const demand = departure && target && queuePlayerLanding(world, departure, target, size.valueAsNumber,
      tick.value ? tick.valueAsNumber : world.time.fastTick);
    result.textContent = demand ? "Plan scheduled." : "Check the enemy port, friendly departure port, force size, and launch time.";
  };
  return () => {
    const player = getPlayerNation(world);
    if (actor !== player) {
      actor = player;
      departure = null;
      tick.value = "";
      result.textContent = "";
    }
    section.hidden = player?.commandMode !== "assisted";
    if (section.hidden || !player) return;
    tick.placeholder = String(world.time.fastTick);
    ports.textContent = `Departure port: ${departure ?? "Not set"} ／ Destination: ${getDestination() ?? "Not selected"}`;
    const operations = world.amphibiousOperations;
    const plans = operations.capabilityDemands.filter((demand) => player.landingPlanIds.has(demand.id))
      .map((demand) => ({ demand, operation: operations.operations.find((op) => op.id === demand.operationId) }));
    const next = plans.map(({ demand, operation }) => [demand.id, demand.state, demand.waitingReason, operation?.phase]).join("|");
    if (next === key) return;
    key = next;
    list.replaceChildren(...plans.map(({ demand, operation }) => {
      const item = document.createElement("li");
      const state = operation?.phase ?? demand.waitingReason ?? demand.state;
      item.textContent = `${demand.departurePortId} → ${demand.destinationPortId} · ${demand.playerPlan?.unitCount} units · ${state} `;
      if (!operation && demand.state !== "expired") {
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.textContent = "Cancel";
        cancel.onclick = () => { cancelPlayerLanding(world, demand.id); };
        item.append(cancel);
      }
      return item;
    }));
  };
}
