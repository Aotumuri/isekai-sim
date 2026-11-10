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

export function attachPlayerDiplomacyControls(panel: HTMLElement, world: WorldState, openNegotiations: () => void): () => void {
  const section = document.createElement("details");
  section.innerHTML = `<summary>外交</summary>
    <div class="player-counterpart"><small>外交相手</small><strong data-target></strong></div>
    <div data-diplomatic-actions hidden>
    <div class="player-war-actions">
      <button type="button" data-declare>宣戦布告</button>
      <button type="button" data-propose-peace>白紙講和を提案</button>
      <button type="button" data-negotiations>講和条件を見る</button>
    </div>
    <p data-war-note></p>
    <label>その他の外交 <select data-action>
      <option value="relations">関係改善</option>
      <option value="trade">通商条約</option>
      <option value="non-aggression">不可侵条約</option>
      <option value="alliance">同盟</option>
      <option value="crisis">最後通牒</option>
      <option value="negotiate">最後通牒に交渉で応じる</option>
      <option value="break-nap">不可侵条約を破棄</option>
      <option value="break-alliance">同盟条約を破棄</option>
    </select></label>
    <button type="button" data-execute>実行</button><p role="status"></p></div>`;
  panel.append(section);
  const target = section.querySelector<HTMLElement>("[data-target]")!;
  const action = section.querySelector<HTMLSelectElement>("[data-action]")!;
  const actions = section.querySelector<HTMLElement>("[data-diplomatic-actions]")!;
  const button = section.querySelector<HTMLButtonElement>("[data-execute]")!;
  const declare = section.querySelector<HTMLButtonElement>("[data-declare]")!;
  const propose = section.querySelector<HTMLButtonElement>("[data-propose-peace]")!;
  const negotiations = section.querySelector<HTMLButtonElement>("[data-negotiations]")!;
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
      case "break-nap": accepted = breakTreaty(world, actor, partner, "non-aggression"); break;
      case "break-alliance": accepted = breakTreaty(world, actor, partner, "alliance"); break;
    }
    result.textContent = accepted ? "外交行動を実行しました。" : "現在の関係や世界設定では実行できません。";
  };
  declare.onclick = () => {
    const partner = getPartner();
    if (partner && startPlayerWar(world, partner)) result.textContent = "宣戦しました。";
  };
  propose.onclick = () => {
    const actor = getPlayerNation(world)?.nationId;
    const partner = getPartner();
    if (!actor || !partner) return;
    result.textContent = offerPeace(world, actor, partner)
      ? getPlayerWarIssue(world, partner) === "already-at-war" ? "白紙講和を提案しました。相手の回答を待っています。" : "相手が白紙講和を受諾しました。"
      : "現在は講和を提案できません。";
  };
  negotiations.onclick = openNegotiations;
  return () => {
    const actor = getPlayerNation(world)?.nationId;
    section.hidden = !actor;
    const partner = getPartner();
    const key = `${actor ?? ""}:${partner ?? ""}`;
    if (selection !== key) {
      selection = key;
      result.textContent = "";
    }
    const name = partner ? getNationName(world, partner) : "地図で相手国を選択";
    if (target.textContent !== name) target.textContent = name;
    actions.hidden = !actor || !partner;
    if (!actor || !partner) return;
    const issue = getPlayerWarIssue(world, partner);
    const atWar = issue === "already-at-war";
    declare.hidden = atWar;
    declare.disabled = !!issue;
    propose.hidden = negotiations.hidden = !atWar;
    const note = issue ? WAR_ISSUES[issue] : "宣戦すると、すぐに交戦状態になります。";
    if (warNote.textContent !== note) warNote.textContent = note;
  };
}
