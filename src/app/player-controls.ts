import { attachPlayerLandingControls } from "./player-landing-controls";
import { attachPlayerMilitaryControls } from "./player-military-controls";
import type { MesoRegionId } from "../worldgen/meso-region";
import { attachPlayerDiplomacyControls } from "./player-diplomacy-controls";
import { isNationActive } from "../sim/nation-active";
import { getNationName } from "../sim/nation-identity";
import { enterPlayerNation, getPlayerNation, leavePlayerNation } from "../sim/player-nation";
import type { WorldState } from "../sim/world-state";
import { getMapView, selectMapNation } from "../render/map-view-state";

export function attachPlayerControls(
  root: HTMLElement, world: WorldState, getDestination: () => MesoRegionId | null, setGovernmentHost: (host: HTMLElement | null) => void, openNegotiations: () => void,
): () => void {
  const panel = document.createElement("aside");
  panel.className = "map-controls player-controls";
  panel.setAttribute("aria-label", "Nation information");
  panel.innerHTML = `<header><small></small><h2></h2><p data-overview></p></header>
    <button type="button" data-enter>Take control</button>
    <div data-command data-current-tab="orders" hidden>
      <div class="player-toolbar">
        <label><input type="checkbox" data-automatic> Delegate government and diplomacy to AI</label>
        <button type="button" data-leave>Return to observer mode</button>
      </div>
      <nav aria-label="Nation controls">
        <button type="button" data-player-tab="orders" aria-pressed="true">Diplomacy & Military</button>
        <button type="button" data-player-tab="government" aria-pressed="false">Government & Research</button>
      </nav>
      <div data-orders-pane></div>
    </div>`;
  root.append(panel);
  const command = panel.querySelector<HTMLElement>("[data-command]")!;
  const orders = panel.querySelector<HTMLElement>("[data-orders-pane]")!;
  const automatic = panel.querySelector<HTMLInputElement>("[data-automatic]")!;
  const tabs = [...panel.querySelectorAll<HTMLButtonElement>("[data-player-tab]")];
  const selectTab = (id: string) => {
    orders.hidden = id !== "orders";
    command.dataset.currentTab = id;
    panel.scrollTop = 0;
    for (const tab of tabs) tab.setAttribute("aria-pressed", String(tab.dataset.playerTab === id));
  };
  for (const tab of tabs) tab.onclick = () => selectTab(tab.dataset.playerTab!);
  automatic.onchange = () => {
    const player = getPlayerNation(world);
    if (player) player.automaticGovernment = automatic.checked;
  };
  const updateDiplomacy = attachPlayerDiplomacyControls(orders, world, () => {
    selectTab("government");
    openNegotiations();
  });
  const updateMilitary = attachPlayerMilitaryControls(orders, world, getDestination);
  const updateLandings = attachPlayerLandingControls(orders, world, getDestination);
  const heading = panel.querySelector("h2")!;
  const label = panel.querySelector("small")!;
  const overview = panel.querySelector<HTMLElement>("[data-overview]")!;
  const enter = panel.querySelector<HTMLButtonElement>("[data-enter]")!;
  const update = () => {
    const player = getPlayerNation(world);
    setGovernmentHost(player ? command : null);
    const id = player?.nationId ?? getMapView(world).selectedNationId;
    const nation = world.nations.find((entry) => entry.id === id);
    panel.hidden = !nation;
    if (!nation) return;
    const name = getNationName(world, nation.id);
    const wars = world.wars.filter((war) => war.nationAId === id || war.nationBId === id).length;
    const summary = `Provinces: ${nation.macroRegionIds.length} · ${wars ? `Active wars: ${wars}` : "At peace"}`;
    if (overview.textContent !== summary) overview.textContent = summary;
    if (heading.textContent !== name) heading.textContent = name;
    const caption = player ? "Controlled nation" : "Selected nation";
    if (label.textContent !== caption) label.textContent = caption;
    enter.hidden = !!player || !isNationActive(nation);
    command.hidden = !player;
    if (player) {
      automatic.checked = player.automaticGovernment;
      updateDiplomacy();
      updateMilitary();
      updateLandings();
    }
  };
  enter.onclick = () => {
    const id = getMapView(world).selectedNationId;
    if (id && enterPlayerNation(world, id)) {
      getMapView(world).targetNationId = null;
      selectMapNation(world, id);
      selectTab("orders");
      orders.querySelector("details")!.open = true;
    }
    update();
  };
  panel.querySelector<HTMLButtonElement>("[data-leave]")!.onclick = () => {
    const id = getPlayerNation(world)?.nationId;
    leavePlayerNation(world);
    if (id) selectMapNation(world, id);
    update();
  };
  update();
  return update;
}
