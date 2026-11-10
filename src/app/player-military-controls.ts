import { issuePlayerNavalOrder } from "../sim/player-naval-orders";
import { clearPlayerLandOrders, issuePlayerLandOrder, setPlayerCommandMode } from "../sim/player-land-orders";
import { getPlayerNation } from "../sim/player-nation";
import type { WorldState } from "../sim/world-state";
import type { MesoRegionId } from "../worldgen/meso-region";

export function attachPlayerMilitaryControls(
  panel: HTMLElement, world: WorldState, getDestination: () => MesoRegionId | null,
): () => void {
  const section = document.createElement("details");
  section.innerHTML = `<summary>軍事指揮</summary>
    <label>指揮方式 <select data-mode>
      <option value="automatic">自動</option>
      <option value="assisted">補助あり</option>
      <option value="manual">手動</option>
    </select></label>
    <div data-orders>
      <p data-destination></p>
      <label data-unit-label>部隊 <select data-unit></select></label>
      <label data-count-label>部隊数 <input data-count type="number" min="1" value="1"></label>
      <button type="button" data-move>選択した地域へ移動</button>
      <button type="button" data-clear>陸軍の命令を解除</button>
    </div><p role="status"></p>`;
  panel.append(section);
  const mode = section.querySelector<HTMLSelectElement>("[data-mode]")!;
  const unit = section.querySelector<HTMLSelectElement>("[data-unit]")!;
  const count = section.querySelector<HTMLInputElement>("[data-count]")!;
  const destination = section.querySelector<HTMLElement>("[data-destination]")!;
  const result = section.querySelector<HTMLElement>("[role=status]")!;
  let roster = "";
  let actor = "";
  mode.onchange = () => {
    if (mode.value === "automatic" || mode.value === "assisted" || mode.value === "manual") {
      setPlayerCommandMode(world, mode.value);
      result.textContent = "";
    }
  };
  section.querySelector<HTMLButtonElement>("[data-move]")!.onclick = () => {
    const player = getPlayerNation(world);
    const target = getDestination();
    const selected = world.units.find(({ id }) => id === unit.value);
    const order = player?.commandMode === "assisted" ? count.valueAsNumber : selected?.id;
    const issued = target && order !== undefined
      ? player?.commandMode === "manual" && selected?.domain === "naval"
        ? Number(issuePlayerNavalOrder(world, selected.id, target))
        : issuePlayerLandOrder(world, target, order)
      : 0;
    result.textContent = issued ? `${issued} 部隊に命令しました。` : "地域または移動可能な部隊を選んでください。";
  };
  section.querySelector<HTMLButtonElement>("[data-clear]")!.onclick = () => {
    clearPlayerLandOrders(world);
    result.textContent = "陸軍の命令を解除しました。";
  };
  return () => {
    const player = getPlayerNation(world);
    section.hidden = !player;
    if ((player?.nationId ?? "") !== actor) {
      actor = player?.nationId ?? "";
      result.textContent = "";
    }
    if (!player) return;
    mode.value = player.commandMode;
    section.querySelector<HTMLElement>("[data-orders]")!.hidden = player.commandMode === "automatic";
    section.querySelector<HTMLElement>("[data-unit-label]")!.hidden = player.commandMode !== "manual";
    section.querySelector<HTMLElement>("[data-count-label]")!.hidden = player.commandMode !== "assisted";
    const target = getDestination();
    destination.textContent = target ? `選択地域 ${target}` : "目的地を地図で選んでください。";
    if (player.commandMode !== "manual") return;
    const units = world.units.filter((item) => item.nationId === player.nationId);
    const key = units.map((item) => `${item.id}:${item.regionId}`).join(",");
    if (key === roster) return;
    const previous = unit.value;
    unit.replaceChildren(...units.map((item) => new Option(`${item.type} ${item.id} · ${item.regionId}`, item.id)));
    if (units.some(({ id }) => id === previous)) unit.value = previous;
    roster = key;
  };
}
