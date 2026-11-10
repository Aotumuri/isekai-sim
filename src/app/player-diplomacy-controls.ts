import { getMapView } from "../render/map-view-state";
import { offerPeace } from "../sim/diplomatic-peace";
import { getPlayerWarIssue, openDiplomaticCrisis, respondToCrisis, startPlayerWar } from "../sim/diplomatic-crises";
import { breakTreaty, improveRelations, proposeTreaty } from "../sim/diplomacy";
import { isNationActive } from "../sim/nation-active";
import { getNationName } from "../sim/nation-identity";
import { getPlayerNation } from "../sim/player-nation";
import type { WorldState } from "../sim/world-state";

const WAR_ISSUES = {
  "invalid-target": "地図で相手国を選んでください。",
  "already-at-war": "すでに交戦中です。講和を提案できます。",
  subject: "従属国は宗主国が交戦している相手にのみ宣戦できます。",
  truce: "休戦中です。休戦の期限が切れるまで宣戦できません。",
  "non-aggression": "不可侵条約を破棄すると宣戦できます。",
  alliance: "同盟条約を破棄すると宣戦できます。",
  protected: "同じ陣営、宗属関係、または防衛協定で保護されています。",
};

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
      <option value="break-nap">不可侵条約を破棄</option>
      <option value="break-alliance">同盟条約を破棄</option>
      <option value="peace">講和を提案</option>
    </select></label>
    <p data-war-note></p><button type="button">実行</button><p role="status"></p>`;
  panel.append(section);
  const target = section.querySelector<HTMLElement>("[data-target]")!;
  const action = section.querySelector<HTMLSelectElement>("[data-action]")!;
  const button = section.querySelector("button")!;
  const result = section.querySelector<HTMLElement>("[role=status]")!;
  const warNote = section.querySelector<HTMLElement>("[data-war-note]")!;
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
      case "war": accepted = startPlayerWar(world, partner); break;
      case "break-nap": accepted = breakTreaty(world, actor, partner, "non-aggression"); break;
      case "break-alliance": accepted = breakTreaty(world, actor, partner, "alliance"); break;
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
    const issue = action.value === "war" && partner ? getPlayerWarIssue(world, partner) : null;
    const note = action.value === "war" && partner
      ? issue ? WAR_ISSUES[issue] : "宣戦は即時です。離れた国へ進軍するには別途、移動や上陸の準備が必要です。"
      : "";
    if (warNote.textContent !== note) warNote.textContent = note;
    button.disabled = !actor || !partner || actor === partner || !!issue;
    button.textContent = action.value === "war" ? "宣戦する" : "実行";
  };
}
