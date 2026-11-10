import { getRelation, getInfluence } from "../sim/diplomacy";
import { isNationActive } from "../sim/nation-active";
import { ideologyAffinityLabel } from "../sim/ideology-relations";
import type { NationId } from "../worldgen/nation";
import type { WorldState } from "../sim/world-state";
import { createFaction, getNationFaction, joinFaction, leaveFaction, setNationIdeology, getFactionCohesion, getFactionAdmissionIssue, transferFactionLeadership, expelFactionMember, type WarObligation } from "../sim/factions";
import { createIdeology, getIdeologies, getNationIdeology, getNationName } from "../sim/nation-identity";
import { getWarDeclarationMode } from "../sim/simulation-settings";
const esc = (text: unknown) => String(text).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));

const OBLIGATION_LABELS = { mandatory: "義務", voluntary: "任意", none: "なし" };

export function attachFactionControls(root: HTMLElement, world: WorldState, selected: () => NationId,
  feedback: (message: string) => void): { update: () => void } {
  root.innerHTML = `<h2>思想と陣営</h2><p class="society-note">同じ陣営の国は地図で同じ色になります。思想が近いほど協力しやすく、異なる思想の国が加盟するには全加盟国との強い関係が必要です。共通の脅威は協力を後押しします。</p>
    <label>国家の思想（自由設定）<select data-faction-control="national-ideology" aria-label="国家の思想"></select></label>
    <div data-faction-view="membership"></div>
    <h2>陣営を結成</h2><label>陣営名<input type="text" data-faction-control="name" aria-label="陣営名" maxlength="60" placeholder="自動で命名"></label>
    <p class="society-note">初期設定では自国の思想が選ばれます。他の思想も認めると陣営の幅が広がります。加盟には外交上の信頼と良好な関係が必要です。</p><fieldset class="faction-ideologies"><legend>参加可能な思想</legend><div data-faction-view="ideologies"></div></fieldset>
    <div class="society-selectors"><label>加盟国が攻撃された場合<select data-faction-control="defense" aria-label="防衛義務"><option value="mandatory">参戦義務あり</option><option value="voluntary">任意参戦</option><option value="none">参戦しない</option></select></label>
    <label>加盟国が攻撃した場合<select data-faction-control="offense" aria-label="攻撃時の義務"><option value="none">参戦しない</option><option value="voluntary">任意参戦</option><option value="mandatory">参戦義務あり</option></select></label></div>
    <label><input type="checkbox" data-faction-control="personality" checked> 加盟審査で国の性格を考慮</label>
    <label><input type="checkbox" data-faction-control="joint-peace"> 加盟国が同じ相手と交戦中は共同講和を義務づける</label>
    <p class="society-note">参戦義務は消極的な国や余力のない国にも適用され、既存の条約に優先する場合があります。任意参戦は拒否できます。性格を考慮する加盟審査では、慎重な国は危険な規約を拒むことがあります。思想の要件は常に適用されます。</p>
    <div class="society-actions"><button type="button" data-faction-action="create">陣営を結成 · 20 influence</button><button type="button" data-faction-action="leave">陣営を脱退</button></div>
    <h2>陣営一覧</h2><div data-faction-view="directory"></div>
    <h2>思想を定義</h2><div class="society-trade-form"><label>思想名<input type="text" data-faction-control="custom-name" aria-label="新しい思想の名前" maxlength="40" placeholder="例：海洋連邦主義"></label><button type="button" data-faction-action="ideology">思想を追加</button></div>`;
  const input = (name: string) => root.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-faction-control="${name}"]`)!;
  const view = (name: string) => root.querySelector<HTMLElement>(`[data-faction-view="${name}"]`)!;
  let registryKey = "", draftIdentity = "";
  const update = () => {
    const nationId = selected(); if (!world.nations.some((nation) => nation.id === nationId)) return;
    const ideology = getNationIdeology(world, nationId), identity = `${nationId}:${ideology.id}`;
    const ideologies = getIdeologies(world), next = ideologies.map((item) => item.id).join("|");
    if (registryKey !== next || draftIdentity !== identity) {
      const old = new Set([...root.querySelectorAll<HTMLInputElement>("[data-eligible]:checked")].map((item) => item.value));
      input("national-ideology").innerHTML = ideologies.map((item) => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join("");
      view("ideologies").innerHTML = ideologies.map((item) => `<label><input type="checkbox" data-eligible value="${esc(item.id)}" ${(draftIdentity === identity ? old.has(item.id) : item.id === ideology.id) ? "checked" : ""}> ${esc(item.name)}</label>`).join("");
      registryKey = next; draftIdentity = identity;
    }
    if (document.activeElement !== input("national-ideology")) input("national-ideology").value = getNationIdeology(world, nationId).id;
    const faction = getNationFaction(world, nationId), mode = getWarDeclarationMode(world) === "diplomacy";
    const leadershipReady = (id: NationId) => {
      const relation = getRelation(world, nationId, id);
      return mode && getInfluence(world, nationId) >= 10 && relation.opinion >= 25 && relation.trust >= 55 &&
        world.nations.some((nation) => nation.id === id && isNationActive(nation));
    };
    const canExpel = mode && getInfluence(world, nationId) >= 10 && !faction?.memberIds.some((id) =>
      world.exileGovernments?.byNationId.get(id)?.status === "exiled" || world.wars.some((war) => war.nationAId === id || war.nationBId === id));
    view("membership").innerHTML = faction ? `<div class="society-country"><strong>${esc(faction.name)}</strong><small>指導国： ${esc(getNationName(world, faction.leaderId))}<br>${faction.memberIds.map((id) => esc(getNationName(world, id)) + (world.exileGovernments?.byNationId.get(id)?.status === "exiled" ? " (in exile)" : "")).join(" · ")}<br>防衛義務：${OBLIGATION_LABELS[faction.charter.defensiveObligation]} / 攻撃時の義務：${OBLIGATION_LABELS[faction.charter.offensiveObligation]} · ${faction.charter.jointPeaceOnly ? "共同講和が必要" : "単独講和可"}</small>${faction.leaderId === nationId ? `<p class="society-note">指導国は、関係25・信頼55以上の加盟国に指導権を譲渡できます。陣営全体が平時なら加盟国を除名できます。</p>${faction.memberIds.filter((id) => id !== nationId).map((id) => `<div class="society-actions"><button type="button" data-faction-action="leadership" data-member-id="${esc(id)}" ${leadershipReady(id) ? "" : "disabled"} title="Requires a government with territory, opinion 25, trust 55 and 10 influence.">${esc(getNationName(world, id))}に指導権を譲渡 · 10</button><button type="button" data-faction-action="expel" data-member-id="${esc(id)}" ${canExpel ? "" : "disabled"} title="Requires 10 influence, every member at peace and no ongoing exile liberation war.">Expel ${esc(getNationName(world, id))} · 10</button></div>`).join("")}` : `<p class="society-note">指導国のみが指導権の譲渡や加盟国の除名を行えます。</p>`}</div>` : '<p class="society-note">無所属です。既存の陣営に加盟するか、新たに結成できます。</p>';
    view("directory").innerHTML = (world.factions?.factions ?? []).map((item) => {
      const cohesion = getFactionCohesion(world, item), issue = getFactionAdmissionIssue(world, nationId, item);
      return `<article class="faction-entry"><strong>${esc(item.name)}</strong><p>指導国： ${esc(getNationName(world, item.leaderId))}</p><p>${item.memberIds.map((id) => esc(getNationName(world, id)) + (world.exileGovernments?.byNationId.get(id)?.status === "exiled" ? " (in exile)" : "")).join(" · ")}</p><p class="society-note">${item.charter.allowedIdeologyIds.map((id) => esc(ideologies.find((ideology) => ideology.id === id)?.name ?? id)).join(" / ")}<br>防衛義務：${OBLIGATION_LABELS[item.charter.defensiveObligation]} · 攻撃時の義務：${OBLIGATION_LABELS[item.charter.offensiveObligation]} · 加盟審査で性格を考慮：${item.charter.considerPersonality ? "はい" : "いいえ"}<br>${item.memberIds.length < 2 ? "Founding member; awaiting partners" : `Internal ideology: ${ideologyAffinityLabel(cohesion.affinity)} · Average opinion ${Math.round(cohesion.opinion)} / trust ${Math.round(cohesion.trust)}`}</p>${!faction && issue ? `<p class="society-note">${esc(issue)}</p>` : ""}<button type="button" data-faction-action="join" data-faction-id="${esc(item.id)}" ${issue || !mode ? "disabled" : ""}>Join · 5 influence</button></article>`; }).join("") || '<p class="society-note">結成済みの陣営はありません。</p>';
    (root.querySelector('[data-faction-action="create"]') as HTMLButtonElement).disabled = !!faction || !mode;
    (root.querySelector('[data-faction-action="leave"]') as HTMLButtonElement).disabled = !faction || !mode;
  };
  root.addEventListener("change", (event) => {
    const target = event.target as HTMLSelectElement;
    if (target.dataset.factionControl !== "national-ideology") return;
    const success = setNationIdeology(world, selected(), target.value);
    feedback(success ? "国家思想と政権の方針を変更しました。" : "規約で認められていない思想を採用するには、先に陣営を脱退してください。"); update();
  });
  root.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-faction-action]"); if (!button) return;
    event.stopPropagation(); let success = false;
    if (button.dataset.factionAction === "create") success = !!createFaction(world, selected(), {
      allowedIdeologyIds: [...root.querySelectorAll<HTMLInputElement>("[data-eligible]:checked")].map((item) => item.value),
      defensiveObligation: input("defense").value as WarObligation, offensiveObligation: input("offense").value as WarObligation,
      considerPersonality: (input("personality") as HTMLInputElement).checked,
      jointPeaceOnly: (input("joint-peace") as HTMLInputElement).checked,
    }, input("name").value);
    if (button.dataset.factionAction === "leave") success = leaveFaction(world, selected());
    if (button.dataset.factionAction === "join") success = joinFaction(world, selected(), button.dataset.factionId!);
    if (button.dataset.factionAction === "leadership") success = transferFactionLeadership(world, selected(), button.dataset.memberId as NationId);
    if (button.dataset.factionAction === "expel") success = expelFactionMember(world, selected(), button.dataset.memberId as NationId);
    if (button.dataset.factionAction === "ideology") success = !!createIdeology(world, input("custom-name").value);
    feedback(success ? "陣営または思想を更新しました。" : "Requirements not met: check ideology, membership, relations, influence and personality acceptance. Leadership transfer requires opinion 25 and trust 55; expulsion requires every member to be at peace."); update();
  });
  return { update };
}
