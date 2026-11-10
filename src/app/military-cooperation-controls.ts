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
  root.innerHTML = `<details><summary>軍事協力</summary><p class="society-note" data-cooperation-view="trust"></p>
    <h3>軍事通行権</h3><p class="society-note">軍事通行権があれば相手国で移動・駐留し、現地補給を受けられます。付与・要請には関係20と信頼60が必要で、信頼50未満で失効します。同盟国にも許可が必要です。</p><div data-cooperation-view="access"></div>
    <div class="society-actions"><button type="button" data-cooperation-action="grant">通行を許可 · 6</button><button type="button" data-cooperation-action="request-access">通行を要請 · 6</button><button type="button" data-cooperation-action="revoke">相手国の通行権を取り消す</button></div>
    <label>配置・派遣する部隊数<input type="number" min="1" max="5" step="1" value="2" aria-label="軍事協力の部隊数" data-cooperation-control="count"></label>
    <div class="society-actions"><button type="button" data-cooperation-action="stage">相手国に部隊を配置</button><button type="button" data-cooperation-action="withdraw-visitors">駐留部隊を撤収</button></div>
    <p class="society-note">部隊は許可された領土を平時の移動で通過します。撤収すると配置命令が取り消されます。許可を取り消された中立部隊には帰国まで15秒の猶予があります。事前配置しても宣戦は必要です。</p>
    <h3>同盟国に参戦を要請</h3><p class="society-note">同盟または同じ陣営への所属、関係25、信頼60が必要です。相手は拒否できます。AIは10秒後に検討し、要請は45秒で失効します。再要請まで120秒かかります。敵国との保護条約がある場合は参戦できません。</p><label>交戦相手<select aria-label="Call ally against" data-cooperation-control="enemy"></select></label><button type="button" data-cooperation-action="call">Request allied entry · 8</button>
    <div data-cooperation-view="requests"></div>
    <h3>義勇軍</h3><p class="society-note">交戦中の友好国へ、補給の届く既存部隊を派遣します。信頼55、関係40（同盟国は35）が必要です。国内に3部隊以上を残し、国外への派遣は最大8部隊です。正式には参戦しませんが、敵国の反発を招きます。移動には補給の届く陸路か、燃料を使う民間船を利用します。</p>
    <button type="button" data-cooperation-action="volunteers">義勇軍を派遣 · 10</button><div data-cooperation-view="volunteers"></div>
    <p class="society-note">義勇軍は受入国の指揮下で戦います。人員は派遣国の動員に含まれ、部隊数は両国の上限に数えます。生存部隊は召還・帰国させられますが、孤立、交戦、乗船中は安全を確保する必要があります。失われた人員は戻りません。</p></details>`;
  const view = (name: string) => root.querySelector<HTMLElement>(`[data-cooperation-view="${name}"]`)!;
  const input = (name: string) => root.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-cooperation-control="${name}"]`)!;
  let enemyKey = "", contentKey = "";
  const update = () => {
    const a = selected(), b = partner(); if (!a || !b) return;
    const relation = getRelation(world, a, b), wars = world.wars.filter((war) => war.nationAId === a || war.nationBId === a);
    const key = `${a}:${wars.map((war) => `${war.id}:${war.startedAtFastTick}`).join("|")}`;
    if (key !== enemyKey) {
      enemyKey = key; const old = input("enemy").value;
      input("enemy").innerHTML = wars.map((war) => { const id = war.nationAId === a ? war.nationBId : war.nationAId; return `<option value="${esc(id)}">${esc(getNationName(world, id))}</option>`; }).join("") || '<option value="">交戦中の戦争はありません</option>';
      if (wars.some((war) => war.nationAId === old || war.nationBId === old)) input("enemy").value = old;
    }
    view("trust").textContent = `Partner: ${getNationName(world, b)} · Opinion ${Math.round(relation.opinion)} · Trust ${Math.round(relation.trust)}/100`;
    const guests = hasMilitaryAccess(world, b, a), hosts = hasMilitaryAccess(world, a, b);
    view("access").textContent = `${guests ? "相手国に自国領の通行を許可しています。" : "相手国に自国領の通行を許可していません。"} ${hosts ? "自国の部隊は相手国の領土を通行できます。" : "Your troops have no access to partner territory."} Active staging orders: ${[...(world.militaryAccess?.orders.values() ?? [])].filter((order) => order.nationId === a).length}.`;
    const requests = (world.alliedWarRequests?.requests ?? []).filter((request) => request.callerId === a || request.allyId === a).slice(-6).reverse();
    const missions = (world.volunteers?.missions ?? []).filter((mission) => mission.donorId === a || mission.recipientId === a).slice(-6).reverse();
    const field = allFieldUnits(world);
    const next = JSON.stringify([a, b, requests.map((request) => [request.id, request.status]), missions.map((mission) => [mission.id, mission.status, mission.returnedUnits, field.filter((unit) => unit.volunteerMissionId === mission.id).length])]);
    if (next !== contentKey) {
      contentKey = next;
      view("requests").innerHTML = requests.map((request) => `<article class="faction-entry"><strong>${esc(getNationName(world, request.callerId))} → ${esc(getNationName(world, request.allyId))} · ${request.status}</strong><p class="society-note">Against ${esc(getNationName(world, request.enemyId))} · ${request.defensive ? "Defensive" : "Offensive"} war</p>${request.status === "pending" ? `<div class="society-actions">${request.allyId === a ? `<button type="button" data-cooperation-action="accept-call" data-request-id="${request.id}">参戦要請を受諾</button><button type="button" data-cooperation-action="decline-call" data-request-id="${request.id}">参戦要請を拒否</button>` : `<button type="button" data-cooperation-action="withdraw-call" data-request-id="${request.id}">参戦要請を撤回</button>`}</div>` : ""}</article>`).join("") || '<p class="society-note">参戦要請はありません。AIは10秒後に検討し、45秒後に失効します。</p>';
      view("volunteers").innerHTML = missions.map((mission) => `<article class="faction-entry"><strong>${esc(getNationName(world, mission.donorId))} → ${esc(getNationName(world, mission.recipientId))} · ${mission.status}</strong><p class="society-note">Originally sent: ${mission.unitIds.length} · Surviving / in transit: ${field.filter((unit) => unit.volunteerMissionId === mission.id).length} · Returned: ${mission.returnedUnits}</p>${["active", "outbound"].includes(mission.status) ? `<button type="button" data-cooperation-action="${mission.donorId === a ? "recall" : "dismiss"}" data-mission-id="${mission.id}">${mission.donorId === a ? "義勇軍を呼び戻す" : "義勇軍を帰国させる"}</button>` : ""}</article>`).join("") || '<p class="society-note">義勇軍の派遣はまだありません。</p>';
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
    feedback(success ? "軍事協力を更新しました。通行権、移動命令、参戦要請、義勇軍を確認してください。" : "Requirements not met: check trust, opinion, influence, allies, active wars, protected treaties, routes and available home troops.");
    update();
  });
  return { update };
}
