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
  root: HTMLElement, world: WorldState, getDestination: () => MesoRegionId | null, openResearch: () => void,
): () => void {
  const panel = document.createElement("details");
  panel.className = "map-controls player-controls";
  panel.innerHTML = `<summary>国家プレイ</summary>
    <label>国家 <select data-country></select></label>
    <button type="button" data-enter>操作する</button>
    <button type="button" data-government hidden>国家運営・研究</button>
    <button type="button" data-leave hidden>観戦に戻る</button>
    <p role="status"></p>`;
  root.append(panel);
  const updateMilitary = attachPlayerMilitaryControls(panel, world, getDestination);
  const updateLandings = attachPlayerLandingControls(panel, world, getDestination);
  const updateDiplomacy = attachPlayerDiplomacyControls(panel, world);
  const country = panel.querySelector<HTMLSelectElement>("[data-country]")!;
  const enter = panel.querySelector<HTMLButtonElement>("[data-enter]")!;
  const leave = panel.querySelector<HTMLButtonElement>("[data-leave]")!;
  const government = panel.querySelector<HTMLButtonElement>("[data-government]")!;
  const status = panel.querySelector("p")!;
  let roster = "";
  let mapSelection = getMapView(world).selectedNationId;
  const update = () => {
    updateDiplomacy();
    updateMilitary();
    updateLandings();
    const player = getPlayerNation(world);
    const nations = world.nations.filter(isNationActive);
    const names = nations.map((nation) => getNationName(world, nation.id));
    const nextRoster = JSON.stringify(nations.map((nation, index) => [nation.id, names[index]]));
    if (roster !== nextRoster) {
      const previous = country.value;
      country.replaceChildren(...nations.map((nation, index) => new Option(names[index], nation.id)));
      if (nations.some((nation) => nation.id === previous)) country.value = previous;
      roster = nextRoster;
    }
    const selected = getMapView(world).selectedNationId;
    if (selected !== mapSelection && nations.some((nation) => nation.id === selected)) country.value = selected!;
    mapSelection = selected;
    enter.disabled = !country.value || player?.nationId === country.value;
    leave.hidden = !player;
    government.hidden = !player;
    status.textContent = player ? `${names[nations.findIndex((nation) => nation.id === player.nationId)]}を操作中` : "観戦中";
  };
  government.onclick = openResearch;
  country.addEventListener("change", update);
  enter.addEventListener("click", () => {
    const nation = world.nations.find((entry) => entry.id === country.value);
    if (nation && enterPlayerNation(world, nation.id)) selectMapNation(world, nation.id);
    update();
  });
  leave.addEventListener("click", () => { leavePlayerNation(world); update(); });
  update();
  return update;
}
