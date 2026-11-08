import type { NationId } from "../worldgen/nation";
import type { WorldState } from "../sim/world-state";
import { getNationName } from "../sim/nation-identity";
import { getRelation } from "../sim/diplomacy";
import { getWarDeclarationMode } from "../sim/simulation-settings";
import { grantMilitaryAccess, requestMilitaryAccess, revokeMilitaryAccess, hasMilitaryAccess, stageMilitaryUnits, withdrawMilitaryVisitors } from "../sim/military-access";
import { requestAlliedWarEntry, respondToAlliedWarRequest, withdrawAlliedWarRequest } from "../sim/allied-war-requests";
import { sendVolunteers, recallVolunteers, dismissVolunteers } from "../sim/volunteers";
import { allFieldUnits } from "../sim/mobilization";
const esc = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
export function attachMilitaryCooperationControls(root: HTMLElement, world: WorldState, selected: () => NationId, partner: () => NationId,
  feedback: (message: string) => void): { update: () => void } {
  root.innerHTML = `<details><summary>Military cooperation</summary><p class="society-note" data-cooperation-view="trust"></p>
    <h3>Military access</h3><p class="society-note">Directional permission to move through and stage troops in another country, with local supply. Granting or requesting requires opinion 20 and trust 60; access lapses below trust 50. Allies need explicit permission too.</p><div data-cooperation-view="access"></div>
    <div class="society-actions"><button type="button" data-cooperation-action="grant">Grant access · 6</button><button type="button" data-cooperation-action="request-access">Request access · 6</button><button type="button" data-cooperation-action="revoke">Revoke their access</button></div>
    <label>Units to stage or send<input type="number" min="1" max="5" step="1" value="2" aria-label="Military cooperation troop count" data-cooperation-control="count"></label>
    <div class="society-actions"><button type="button" data-cooperation-action="stage">Stage troops with partner</button><button type="button" data-cooperation-action="withdraw-visitors">Withdraw your visitors</button></div>
    <p class="society-note">Staging uses actual peacetime land movement through permitted territory. Withdrawing cancels staging orders. Revocation gives neutral visitors 15 seconds before repatriation; pre-positioning cannot bypass a declaration of war.</p>
    <h3>Call an ally to war</h3><p class="society-note">Requires an alliance or shared faction, opinion 25 and trust 60. The ally may decline. AI reviews after 10 seconds; requests expire after 45, with a 120-second repeat cooldown. A protected treaty with the enemy prevents entry.</p><label>War against<select aria-label="Call ally against" data-cooperation-control="enemy"></select></label><button type="button" data-cooperation-action="call">Request allied entry · 8</button>
    <div data-cooperation-view="requests"></div>
    <h3>Volunteer forces</h3><p class="society-note">Send existing supplied units to a friendly country at war: trust 55 and opinion 40 (35 for allies). Keep at least 3 home units; at most 8 volunteers abroad. No formal war entry, but enemies resent intervention. Transit uses a supplied land route or a fuel-consuming civilian sea charter.</p>
    <button type="button" data-cooperation-action="volunteers">Send volunteer units · 10</button><div data-cooperation-view="volunteers"></div>
    <p class="society-note">Volunteers fight under the recipient's command. Personnel remain charged to their home country's mobilization; both countries count them toward army capacity. Recall or dismiss survivors; isolated, fighting or embarked units must reach safety before returning. No casualties are recreated.</p></details>`;
  const view = (name: string) => root.querySelector<HTMLElement>(`[data-cooperation-view="${name}"]`)!;
  const input = (name: string) => root.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-cooperation-control="${name}"]`)!;
  let enemyKey = "", contentKey = "";
  const update = () => {
    const a = selected(), b = partner(); if (!a || !b) return;
    const relation = getRelation(world, a, b), wars = world.wars.filter((war) => war.nationAId === a || war.nationBId === a);
    const key = `${a}:${wars.map((war) => `${war.id}:${war.startedAtFastTick}`).join("|")}`;
    if (key !== enemyKey) {
      enemyKey = key; const old = input("enemy").value;
      input("enemy").innerHTML = wars.map((war) => { const id = war.nationAId === a ? war.nationBId : war.nationAId; return `<option value="${esc(id)}">${esc(getNationName(world, id))}</option>`; }).join("") || '<option value="">No active wars</option>';
      if (wars.some((war) => war.nationAId === old || war.nationBId === old)) input("enemy").value = old;
    }
    view("trust").textContent = `Partner: ${getNationName(world, b)} · Opinion ${Math.round(relation.opinion)} · Trust ${Math.round(relation.trust)}/100`;
    const guests = hasMilitaryAccess(world, b, a), hosts = hasMilitaryAccess(world, a, b);
    view("access").textContent = `${guests ? "Partner may enter your territory." : "Partner has no access to your territory."} ${hosts ? "Your troops may enter partner territory." : "Your troops have no access to partner territory."} Active staging orders: ${[...(world.militaryAccess?.orders.values() ?? [])].filter((order) => order.nationId === a).length}.`;
    const requests = (world.alliedWarRequests?.requests ?? []).filter((request) => request.callerId === a || request.allyId === a).slice(-6).reverse();
    const missions = (world.volunteers?.missions ?? []).filter((mission) => mission.donorId === a || mission.recipientId === a).slice(-6).reverse();
    const field = allFieldUnits(world);
    const next = JSON.stringify([a, b, requests.map((request) => [request.id, request.status]), missions.map((mission) => [mission.id, mission.status, mission.returnedUnits, field.filter((unit) => unit.volunteerMissionId === mission.id).length])]);
    if (next !== contentKey) {
      contentKey = next;
      view("requests").innerHTML = requests.map((request) => `<article class="faction-entry"><strong>${esc(getNationName(world, request.callerId))} → ${esc(getNationName(world, request.allyId))} · ${request.status}</strong><p class="society-note">Against ${esc(getNationName(world, request.enemyId))} · ${request.defensive ? "Defensive" : "Offensive"} war</p>${request.status === "pending" ? `<div class="society-actions">${request.allyId === a ? `<button type="button" data-cooperation-action="accept-call" data-request-id="${request.id}">Accept war request</button><button type="button" data-cooperation-action="decline-call" data-request-id="${request.id}">Decline war request</button>` : `<button type="button" data-cooperation-action="withdraw-call" data-request-id="${request.id}">Withdraw war request</button>`}</div>` : ""}</article>`).join("") || '<p class="society-note">No calls to war. AI reviews requests after 10 seconds; they expire after 45 seconds.</p>';
      view("volunteers").innerHTML = missions.map((mission) => `<article class="faction-entry"><strong>${esc(getNationName(world, mission.donorId))} → ${esc(getNationName(world, mission.recipientId))} · ${mission.status}</strong><p class="society-note">Originally sent: ${mission.unitIds.length} · Surviving / in transit: ${field.filter((unit) => unit.volunteerMissionId === mission.id).length} · Returned: ${mission.returnedUnits}</p>${["active", "outbound"].includes(mission.status) ? `<button type="button" data-cooperation-action="${mission.donorId === a ? "recall" : "dismiss"}" data-mission-id="${mission.id}">${mission.donorId === a ? "Recall volunteers" : "Dismiss volunteers"}</button>` : ""}</article>`).join("") || '<p class="society-note">No volunteer missions yet.</p>';
    }
    const enabled = getWarDeclarationMode(world) === "diplomacy" && a !== b;
    for (const button of root.querySelectorAll<HTMLButtonElement>("button[data-cooperation-action]")) button.disabled = !enabled ||
      (button.dataset.cooperationAction === "grant" && guests) || (button.dataset.cooperationAction === "request-access" && hosts) ||
      (button.dataset.cooperationAction === "revoke" && !guests) || (button.dataset.cooperationAction === "stage" && !hosts) ||
      (button.dataset.cooperationAction === "call" && !wars.length);
  };
  root.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-cooperation-action]"); if (!button) return;
    event.stopPropagation(); const a = selected(), b = partner(), action = button.dataset.cooperationAction; let success = false;
    if (action === "grant") success = grantMilitaryAccess(world, a, b);
    if (action === "request-access") success = requestMilitaryAccess(world, a, b);
    if (action === "revoke") success = revokeMilitaryAccess(world, a, b);
    if (action === "stage") success = stageMilitaryUnits(world, a, b, Number(input("count").value)) > 0;
    if (action === "withdraw-visitors") success = withdrawMilitaryVisitors(world, a, b) > 0;
    if (action === "call") success = !!requestAlliedWarEntry(world, a, b, input("enemy").value as NationId);
    if (action === "accept-call" || action === "decline-call") success = respondToAlliedWarRequest(world, a, Number(button.dataset.requestId), action === "accept-call");
    if (action === "withdraw-call") success = withdrawAlliedWarRequest(world, a, Number(button.dataset.requestId));
    if (action === "volunteers") success = !!sendVolunteers(world, a, b, Number(input("count").value));
    if (action === "recall") success = recallVolunteers(world, a, Number(button.dataset.missionId));
    if (action === "dismiss") success = dismissVolunteers(world, a, Number(button.dataset.missionId));
    feedback(success ? "Military cooperation updated. Check access, movement orders, war requests and volunteer missions." : "Requirements not met: check trust, opinion, influence, allies, active wars, protected treaties, routes and available home troops.");
    update();
  });
  return { update };
}
