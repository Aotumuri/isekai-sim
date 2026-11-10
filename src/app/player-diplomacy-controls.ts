import { getMapView } from "../render/map-view-state";
import { offerPeace } from "../sim/diplomatic-peace";
import { openDiplomaticCrisis, respondToCrisis, startDiplomaticWar } from "../sim/diplomatic-crises";
import { improveRelations, proposeTreaty } from "../sim/diplomacy";
import { isNationActive } from "../sim/nation-active";
import { getNationName } from "../sim/nation-identity";
import { getPlayerNation } from "../sim/player-nation";
import type { WorldState } from "../sim/world-state";

export function attachPlayerDiplomacyControls(panel: HTMLElement, world: WorldState): () => void {
  const section = document.createElement("details");
  section.innerHTML = `<summary>外交</summary>
    <p>地図で外交相手の国をクリック</p>
    <p>相手国 <strong data-target></strong></p>
    <label>行動 <select data-action>
      <option value="relations">関係改善</option>
      <option value="trade">通商条約</option>
      <option value="non-aggression">不可侵条約</option>
      <option value="alliance">同盟</option>
      <option value="crisis">最後通牒</option>
      <option value="negotiate">最後通牒に交渉で応じる</option>
      <option value="war">宣戦布告</option>
      <option value="peace">講和を提案</option>
    </select></label>
    <button type="button">実行</button><p role="status"></p>`;
  panel.append(section);
  const target = section.querySelector<HTMLElement>("[data-target]")!;
  const action = section.querySelector<HTMLSelectElement>("[data-action]")!;
  const button = section.querySelector("button")!;
  const result = section.querySelector("p")!;
  const getPartner = () => world.nations.find((nation) =>
    nation.id === getMapView(world).targetNationId && isNationActive(nation))?.id;
  let selection = "";
  button.onclick = () => {
    const actor = getPlayerNation(world)?.nationId;
    const partner = getPartner();
    if (!actor || !partner || actor === partner) return;
    let accepted = false;
    switch (action.value) {
      case "relations": accepted = improveRelations(world, actor, partner); break;
      case "trade":
      case "non-aggression":
      case "alliance": accepted = proposeTreaty(world, actor, partner, action.value); break;
      case "crisis": accepted = openDiplomaticCrisis(world, actor, partner); break;
      case "negotiate": accepted = respondToCrisis(world, actor, partner, "negotiate"); break;
      case "war": accepted = startDiplomaticWar(world, actor, partner); break;
      case "peace": accepted = offerPeace(world, actor, partner); break;
    }
    result.textContent = accepted ? "外交行動を実行しました。" : "現在の関係や世界設定では実行できません。";
  };
  return () => {
    const actor = getPlayerNation(world)?.nationId;
    section.hidden = !actor;
    const partner = getPartner();
    const key = `${actor ?? ""}:${partner ?? ""}`;
    if (selection !== key) {
      selection = key;
      result.textContent = "";
    }
    const name = partner ? getNationName(world, partner) : "未選択";
    if (target.textContent !== name) target.textContent = name;
    button.disabled = !actor || !partner || actor === partner;
  };
}
