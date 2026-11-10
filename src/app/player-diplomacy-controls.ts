import { getMapView } from "../render/map-view-state";
import { offerPeace } from "../sim/diplomatic-peace";
import { getPlayerWarIssue, openDiplomaticCrisis, respondToCrisis, startPlayerWar } from "../sim/diplomatic-crises";
import { breakTreaty, improveRelations, proposeTreaty } from "../sim/diplomacy";
import { isNationActive } from "../sim/nation-active";
import { getNationName } from "../sim/nation-identity";
import { getPlayerNation } from "../sim/player-nation";
import type { WorldState } from "../sim/world-state";

const WAR_ISSUES = {
  "invalid-target": "Select a partner on the map.",
  "already-at-war": "You are already at war with this nation. You can propose peace.",
  subject: "A subject may only declare war on a nation its overlord is already fighting.",
  truce: "You can declare war after the truce expires.",
  "non-aggression": "End the non-aggression pact before declaring war.",
  alliance: "End the alliance before declaring war.",
  protected: "A shared faction, subject relationship, or defense pact prevents a declaration.",
};

export function attachPlayerDiplomacyControls(panel: HTMLElement, world: WorldState, openNegotiations: () => void): () => void {
  const section = document.createElement("details");
  section.innerHTML = `<summary>Diplomacy</summary>
    <div class="player-counterpart"><small>Diplomatic partner</small><strong data-target></strong></div>
    <div data-diplomatic-actions hidden>
    <div class="player-war-actions">
      <button type="button" data-declare>Declare war</button>
      <button type="button" data-propose-peace>Propose white peace</button>
      <button type="button" data-negotiations>View peace terms</button>
    </div>
    <p data-war-note></p>
    <label>Other diplomatic actions <select data-action>
      <option value="relations">Improve relations</option>
      <option value="trade">Trade pact</option>
      <option value="non-aggression">Non-aggression pact</option>
      <option value="alliance">Alliance</option>
      <option value="crisis">Ultimatum</option>
      <option value="negotiate">Negotiate an ultimatum</option>
      <option value="break-nap">End non-aggression pact</option>
      <option value="break-alliance">End alliance</option>
    </select></label>
    <button type="button" data-execute>Apply</button><p role="status"></p></div>`;
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
    result.textContent = accepted ? "Diplomatic action completed." : "Current relations or simulation settings prevent this action.";
  };
  declare.onclick = () => {
    const partner = getPartner();
    if (partner && startPlayerWar(world, partner)) result.textContent = "War declared.";
  };
  propose.onclick = () => {
    const actor = getPlayerNation(world)?.nationId;
    const partner = getPartner();
    if (!actor || !partner) return;
    result.textContent = offerPeace(world, actor, partner)
      ? getPlayerWarIssue(world, partner) === "already-at-war" ? "White peace proposed. Awaiting a response." : "The other nation accepted white peace."
      : "Peace cannot be proposed right now.";
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
    const name = partner ? getNationName(world, partner) : "Select a partner on the map";
    if (target.textContent !== name) target.textContent = name;
    actions.hidden = !actor || !partner;
    if (!actor || !partner) return;
    const issue = getPlayerWarIssue(world, partner);
    const atWar = issue === "already-at-war";
    declare.hidden = atWar;
    declare.disabled = !!issue;
    propose.hidden = negotiations.hidden = !atWar;
    const note = issue ? WAR_ISSUES[issue] : "Declaring war starts hostilities immediately.";
    if (warNote.textContent !== note) warNote.textContent = note;
  };
}
