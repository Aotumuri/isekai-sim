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
  const panel = document.createElement("aside");
  panel.className = "map-controls player-controls";
  panel.setAttribute("aria-label", "国家情報");
  panel.innerHTML = `<header><small></small><h2></h2></header>
    <button type="button" data-enter>この国を操作する</button>
    <div data-command hidden>
      <nav aria-label="国家操作">
        <button type="button" data-government>国家運営・研究</button>
        <button type="button" data-leave>観戦に戻る</button>
      </nav>
    </div>`;
  root.append(panel);
  const command = panel.querySelector<HTMLElement>("[data-command]")!;
  const updateDiplomacy = attachPlayerDiplomacyControls(command, world);
  const updateMilitary = attachPlayerMilitaryControls(command, world, getDestination);
  const updateLandings = attachPlayerLandingControls(command, world, getDestination);
  const heading = panel.querySelector("h2")!;
  const label = panel.querySelector("small")!;
  const enter = panel.querySelector<HTMLButtonElement>("[data-enter]")!;
  const update = () => {
    const player = getPlayerNation(world);
    const id = player?.nationId ?? getMapView(world).selectedNationId;
    panel.hidden = !id;
    if (!id) return;
    const name = getNationName(world, id);
    if (heading.textContent !== name) heading.textContent = name;
    label.textContent = player ? "操作中の国家" : "選択中の国家";
    enter.hidden = !!player || !world.nations.some((nation) => nation.id === id && isNationActive(nation));
    command.hidden = !player;
    if (player) {
      updateDiplomacy();
      updateMilitary();
      updateLandings();
    }
  };
  panel.querySelector<HTMLButtonElement>("[data-government]")!.onclick = openResearch;
  enter.onclick = () => {
    const id = getMapView(world).selectedNationId;
    if (id && enterPlayerNation(world, id)) {
      getMapView(world).targetNationId = null;
      selectMapNation(world, id);
      command.querySelector("details")!.open = true;
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
