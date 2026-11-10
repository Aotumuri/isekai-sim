import { getManualGovernmentId } from "../sim/player-nation";
import { REPARATION_INTERVAL, REPARATION_RESOURCES, type ResourceReparation } from "../sim/resource-reparations";
import { getSeparatePeaceIssue } from "../sim/separate-peace";
import { estimateAnnexationResistance } from "../sim/annexation";
import { planPuppetPartition, type PuppetPartition } from "../sim/puppet-partition";
import { getPuppetTermsIssue, getSubjectOverlord, releaseSubjectGovernment } from "../sim/subject-governments";
import { getWholeProvinces } from "../sim/peace-borders";
import type { NationId } from "../worldgen/nation";
import type { MesoRegionId } from "../worldgen/meso-region";
import type { WorldState } from "../sim/world-state";
import { getCampaignDeadline } from "../sim/campaign-deadline";
import { getWarFatigue } from "../sim/diplomatic-peace";
import { findWar, getWarCasualties } from "../sim/war-state";
import { getNationName } from "../sim/nation-identity";
import { getMesoById, getOwnerByMesoId } from "../sim/world-cache";
import { getWarDeclarationMode, hasPoliticalTurbulence } from "../sim/simulation-settings";
import { getSubjectIntegrationIssue, integrateSubjectGovernment, setGovernancePolicy } from "../sim/territorial-governance";
import { getDomesticUnrest } from "../sim/domestic-unrest";
import { getMapView } from "../render/map-view-state";
import { districtName } from "./territory-controls";
import { getWarNegotiation, getWarAdvantage, getWarTrend, isFightOnGovernment, getPeaceTermsIssue, assessPeaceOffer, proposePeaceTerms, acceptPeaceOffer, type PeaceTerms, type PeaceOffer } from "../sim/war-negotiations";
const esc = (value: unknown) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));
export function attachPeaceControls(root: HTMLElement, world: WorldState, selected: () => NationId, partner: () => NationId,
  feedback: (message: string) => void): { update: () => void } {
  root.innerHTML = `<details open data-peace-panel><summary>講和交渉</summary><p class="society-note" data-peace-view="outlook"></p>
    <p class="society-note" data-peace-view="deliveries"></p><div data-peace-view="subject"></div><div class="peace-offers" data-peace-view="offers"></div><div data-peace-editor>
    <label><input type="checkbox" data-peace-control="automatic" checked> 講和条件の更新・受諾をAIに任せる</label>
    <p class="society-note">開戦時から両国に基本の講和条件があります。損害、占領、戦争疲弊、国内不安が受諾の判断に影響します。自ら条件を提示すると交渉は手動に切り替わります。</p>
    <div class="society-selectors"><label>要求する州<select multiple size="4" data-peace-control="demand" aria-label="Peace demanded provinces"></select></label><label>譲渡する州<select multiple size="4" data-peace-control="offer" aria-label="Peace offered provinces"></select></label></div>
    <div class="society-selectors"><label>要求する武器<input type="number" min="0" max="100" step="1" value="0" data-peace-control="demand-weapons" aria-label="Peace demanded 武器"></label><label>譲渡する武器<input type="number" min="0" max="100" step="1" value="0" data-peace-control="offer-weapons" aria-label="Peace offered 武器"></label></div>
    <div class="society-selectors"><label>資源による賠償<select data-peace-control="reparation-resource"><option value="">なし</option>${REPARATION_RESOURCES.map((resource) => `<option value="${resource}">${resource}</option>`).join("")}</select></label><label>${REPARATION_INTERVAL}秒ごとの数量<input type="number" min="1" max="10" step="1" value="3" data-peace-control="reparation-amount"></label></div>
    <label><input type="checkbox" data-peace-control="puppet"> 相手国に傀儡政権を設置</label>
    <label><input type="checkbox" data-peace-control="partition"> 残る領土を2つの傀儡政権に分割</label>
    ${hasPoliticalTurbulence(world) ? '<label><input type="checkbox" data-peace-control="local-subject"> 要求した州を併合せず、現地の従属国を設立</label>' : ""}
    <p class="society-note" data-peace-view="puppet"></p>
    <p class="society-note" data-peace-view="governance"></p>
    <label>休戦期間<select data-peace-control="truce" aria-label="Peace truce duration"><option value="300">5分</option><option value="600">10分</option><option value="900">15分</option></select></label>
    <p class="society-note" data-peace-view="preview"></p><div class="society-actions"><button type="button" data-peace-action="propose">講和条件を提示</button><button type="button" data-peace-action="accept">相手の条件を受諾</button><button type="button" data-peace-action="map">対象州を地図で確認</button></div>
    <p class="society-note">Ctrl または Command キーで複数の州を選択できます。譲渡する領土は既存領に接するか、島全体を含む必要があります。分割条件で別の政府を設立できます。双方とも領土を残し、第三国の占領地は別途交渉します。条件の受諾時に資源と領土が移り、他の戦争は継続します。</p></div></details>`;
  const control = (name: string) => root.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-peace-control="${name}"]`)!;
  const view = (name: string) => root.querySelector<HTMLElement>(`[data-peace-view="${name}"]`)!;
  const editor = root.querySelector<HTMLElement>("[data-peace-editor]")!;
  let key = "", revision = -1, dirty = false;
  const parcels = new Map<string, MesoRegionId[]>();
  const values = (name: string) => [...(control(name) as HTMLSelectElement).selectedOptions].flatMap((option) => parcels.get(option.value) ?? []);
  const describeDeposits = (ids: MesoRegionId[]) => {
    const regions = getMesoById(world);
    const counts = new Map<string, number>();
    for (const id of ids) {
      const resource = regions.get(id)?.resource;
      if (resource) counts.set(resource, (counts.get(resource) ?? 0) + 1);
    }
    return [...counts].map(([resource, count]) => `${count} ${resource}`).join(", ");
  };
  const describe = (ids: MesoRegionId[]) => {
    const owner = getOwnerByMesoId(world).get(ids[0]);
    const provinces = owner ? getWholeProvinces(world, owner, ids) : null;
    return (provinces ? provinces.map((macro) => `Province ${macro.id.replace("macro-", "")}`)
      : ids.map(districtName)).map(esc).join(", ") || "領土なし";
  };
  let partitionKey = "", cachedPartition: PuppetPartition | undefined;
  const read = (): PeaceTerms => {
    const demandedRegionIds = values("demand");
    const split = (control("partition") as HTMLInputElement).checked;
    if (split) {
      const next = JSON.stringify([selected(), partner(), world.territoryVersion, world.occupation.version, world.wars.length, demandedRegionIds]);
      if (next !== partitionKey) {
        cachedPartition = planPuppetPartition(world, selected(), partner(), demandedRegionIds);
        partitionKey = next;
      }
    }
    const resource = control("reparation-resource").value as ResourceReparation["resource"];
    return { demandedRegionIds, resourceReparation: resource ? { resource, amount: Number(control("reparation-amount").value) } : undefined, offeredRegionIds: values("offer"), demandedWeapons: Number(control("demand-weapons").value),
      offeredWeapons: Number(control("offer-weapons").value), truceSeconds: Number(control("truce").value),
      puppetTarget: split || (control("puppet") as HTMLInputElement).checked || undefined,
      localSubject: root.querySelector<HTMLInputElement>('[data-peace-control="local-subject"]')?.checked || undefined,
      partition: split ? cachedPartition ?? { capitalId: "" as MesoRegionId, districtIds: [] } : undefined };
  };
  const summary = (offer: PeaceOffer) => `<article class="peace-offer"><strong>${esc(getNationName(world, offer.proposerId))}の講和条件</strong><p>要求：${describe(offer.terms.demandedRegionIds)} · ${offer.terms.demandedWeapons} 武器${offer.terms.resourceReparation
    ? ` · ${offer.terms.resourceReparation.amount} ${esc(offer.terms.resourceReparation.resource)} every ${REPARATION_INTERVAL}s during the truce` : ""}</p><p>譲渡：${describe(offer.terms.offeredRegionIds)} · ${offer.terms.offeredWeapons} 武器</p>${offer.terms.partition ? `<p><strong>2つの傀儡政権</strong> · 新首都：${esc(districtName(offer.terms.partition.capitalId))} · ${offer.terms.partition.districtIds.length}地区を新国家に編入</p>` : offer.terms.puppetTarget ? "<p><strong>相手国に傀儡政権を設置</strong></p>" : offer.terms.localSubject ? "<p><strong>要求した州に現地の従属国を設立</strong></p>" : ""}<small>休戦 ${offer.terms.truceSeconds / 60} min · ${offer.source === "opening" ? "当初の条件" : offer.source === "manual" ? "手動で提示" : "政府が更新"}</small></article>`;
  const update = () => {
    const a = selected(), b = partner(), war = findWar(world.wars, a, b);
    const enabled = !!war && (war.cause === "player-declaration" || getWarDeclarationMode(world) === "diplomacy");
    editor.hidden = !enabled;
    const delivery = (world.resourceReparations ?? []).find((term) =>
      (term.payerId === a && term.recipientId === b) || (term.payerId === b && term.recipientId === a));
    view("deliveries").textContent = delivery
      ? `${getNationName(world, delivery.payerId)}は${REPARATION_INTERVAL}秒ごとに${delivery.resource}を${delivery.amount}支払います。次の支払いは${Math.max(0, delivery.nextPaymentAt - world.time.slowTick)}秒後です。在庫に応じて支払われます。` : "";
    const ownOverlord = getSubjectOverlord(world, a);
    const partnerOverlord = getSubjectOverlord(world, b);
    const subjectPolicy = world.nations.find((nation) => nation.id === b)?.governance;
    const integrationIssue = partnerOverlord === a ? getSubjectIntegrationIssue(world, a, b) : undefined;
    const describeSubject = (id: NationId, overlord: NationId | undefined) => overlord
      ? `<p><strong>${esc(getNationName(world, id))}</strong> is a subject of ${esc(getNationName(world, overlord))}. The overlord guarantees its defense and shares military access. Autonomy pressure ${Math.round(world.nations.find((nation) => nation.id === id)?.subjectGovernment?.autonomy ?? 0)}/100.</p>`
      : "";
    view("subject").innerHTML = describeSubject(a, ownOverlord) + (a !== b ? describeSubject(b, partnerOverlord) : "") +
      (partnerOverlord === a ? '<button type="button" data-peace-action="release">独立を認める</button>' : "") +
      (partnerOverlord === a && hasPoliticalTurbulence(world) ? `<p>従属国の統治方針：${subjectPolicy?.policy ?? "centralized"}· 安定度 ${Math.round(subjectPolicy?.stability ?? 100)}/100· 文化・宗教の一致度 ${Math.round((subjectPolicy?.alignment ?? 0) * 100)}%</p>
        <div class="society-actions"><button type="button" data-peace-action="subject-assimilation">同化政策を実施</button><button type="button" data-peace-action="subject-autonomy">地域の自治を保障</button>
        <button type="button" data-peace-action="integrate" ${integrationIssue ? "disabled" : ""}>従属国を統合</button></div>
        ${integrationIssue ? `<p class="society-note">${esc(integrationIssue)}</p>` : ""}` : "");
    if (!enabled || !war) {
      const signed = [...(world.warNegotiations?.settlements ?? [])].reverse().find((item) =>
        (item.a === a && item.b === b) || (item.a === b && item.b === a));
      view("outlook").textContent = signed ? `講和成立 · ${signed.terms.truceSeconds / 60}分間の休戦。 国内不安：${Math.round(getDomesticUnrest(world, a).pressure)}/100. ${world.wars.some((item) => item.nationAId === a || item.nationBId === a) ? "ほかの戦争は継続しています。" : "平時に入り、国内の立て直しが可能です。"}` : getWarDeclarationMode(world) !== "diplomacy" ? "講和交渉を行うには外交システムを有効にしてください。" : "講和条件を確認するには、交戦中の相手国を選んでください。";
      view("offers").innerHTML = signed ? summary({ proposerId: signed.proposerId, terms: signed.terms, source: "manual", revisedAtSlowTick: signed.atSlowTick, revision: 0 }) : "";
      key = ""; return;
    }
    const negotiation = getWarNegotiation(world, war), own = negotiation.offers.get(a)!, opponent = negotiation.offers.get(b)!;
    const unrest = getDomesticUnrest(world, a), advantage = getWarAdvantage(world, a, b);
    const trend = getWarTrend(negotiation, a), deadline = getCampaignDeadline(world, a, b);
    const position = advantage > 0.15 ? "Favorable" : advantage < -0.15 ? "Unfavorable" : "Balanced";
    const direction = trend > 0.08 ? "improving" : trend < -0.08 ? "deteriorating" : "steady";
    const window = deadline <= 75 ? ` · Campaign window ~${Math.ceil(deadline)}s` : "";
    view("outlook").textContent = `戦況：${position}, ${direction}${window} · 国内不安 ${Math.round(unrest.pressure)}/100· 戦争疲弊 ${Math.round(getWarFatigue(world, a, b))}/100 · Battle casualties ${Math.round(getWarCasualties(war, a)).toLocaleString()}. ${isFightOnGovernment(world, a) ? "Government favors fighting on despite unrest." : "Government weighs compromise against domestic danger."}`;
    const incoming = assessPeaceOffer(world, a, b, opponent.terms);
    view("offers").innerHTML = summary(own) + summary(opponent) + `<p class="society-note peace-assessment">相手の条件に対する自国の評価：${esc(incoming.reason)}</p>`;
    const automatic = control("automatic") as HTMLInputElement;
    automatic.disabled = getManualGovernmentId(world) === a;
    automatic.checked = !automatic.disabled && (negotiation.automatic.get(a) ?? true);
    const next = `${negotiation.key}:${a}:${world.territoryVersion}`;
    if (next !== key) {
      parcels.clear();
      const regions = getMesoById(world);
      const options = (id: NationId, existing: MesoRegionId[]) => {
        const current = new Set(existing);
        const output: string[] = [];
        for (const macro of world.macroRegions.filter((item) => item.nationId === id && item.mesoRegionIds.length)) {
          parcels.set(macro.id, macro.mesoRegionIds);
          const capital = macro.mesoRegionIds.some((regionId) => regions.get(regionId)?.building === "capital");
          const deposits = describeDeposits(macro.mesoRegionIds);
          output.push(`<option value="${esc(macro.id)}">州 ${esc(macro.id.replace("macro-", ""))} · ${macro.mesoRegionIds.length} districts${capital ? " · Capital" : ""}${deposits ? ` · ${esc(deposits)}` : ""}</option>`);
          if (!macro.mesoRegionIds.every((regionId) => current.has(regionId))) {
            for (const regionId of macro.mesoRegionIds.filter((item) => current.has(item))) {
              parcels.set(regionId, [regionId]);
              output.push(`<option value="${esc(regionId)}">${esc(districtName(regionId))} · 現在の条件</option>`);
            }
          }
        }
        return output.join("");
      };
      control("demand").innerHTML = options(b, own.terms.demandedRegionIds);
      control("offer").innerHTML = options(a, own.terms.offeredRegionIds); key = next; revision = -1; dirty = false;
    }
    if (!dirty && revision !== own.revision) {
      for (const [name, ids] of [["demand", own.terms.demandedRegionIds], ["offer", own.terms.offeredRegionIds]] as const)
        for (const option of (control(name) as HTMLSelectElement).options) option.selected = (parcels.get(option.value) ?? []).every((id) => ids.includes(id));
      control("demand-weapons").value = String(own.terms.demandedWeapons); control("offer-weapons").value = String(own.terms.offeredWeapons);
      control("reparation-resource").value = own.terms.resourceReparation?.resource ?? "";
      control("reparation-amount").value = String(own.terms.resourceReparation?.amount ?? 3);
      control("truce").value = String(own.terms.truceSeconds);
      (control("puppet") as HTMLInputElement).checked = !!own.terms.puppetTarget && !own.terms.partition;
      (control("partition") as HTMLInputElement).checked = !!own.terms.partition;
      if (hasPoliticalTurbulence(world)) (control("local-subject") as HTMLInputElement).checked = !!own.terms.localSubject;
      revision = own.revision;
    }
    const puppetIssue = getPuppetTermsIssue(world, a, b);
    const puppet = control("puppet") as HTMLInputElement;
    puppet.disabled = !puppet.checked && !!puppetIssue;
    const partition = control("partition") as HTMLInputElement;
    partition.disabled = !partition.checked && !!puppetIssue;
    view("puppet").textContent = puppetIssue ?? "傀儡政権は残る地区を保持し、保護を受けます。分割には、首都と残る地区の60%を占領する必要があります。";
    const terms = read(), issue = getPeaceTermsIssue(world, a, b, terms), assessment = assessPeaceOffer(world, b, a, terms);
    const regions = getMesoById(world);
    const districts = terms.demandedRegionIds;
    const ports = districts.filter((id) => regions.get(id)?.building === "port").length;
    const deposits = describeDeposits(districts);
    const losses = districts.map((id) => estimateAnnexationResistance(world, a, id));
    const average = losses.reduce((sum, value) => sum + value, 0) / Math.max(1, losses.length);
    view("governance").textContent = [
      districts.length ? terms.localSubject ? "The selected provinces form a new subject. The defeated government keeps its independence." :
        `Annexation: ${ports} ports, ${deposits || "no deposits"}, ${Math.round(average * 100)}% average initial output loss across selected districts. Garrisoning speeds integration. During war, supplied troops stationed on captured copper, rubber or tungsten deposits recover half their normal output.` : "",
      terms.partition?.districtIds.length ? `New puppet: ${terms.partition.districtIds.length} districts around ${districtName(terms.partition.capitalId)}.` : "",
      terms.puppetTarget ? "Subjects without domestic steel or fuel may need aid. Large subjects can seek independence when the overlord is weak." : "",
    ].filter(Boolean).join(" ");
    const separateIssue = getSeparatePeaceIssue(world, a, b);
    view("preview").textContent = separateIssue ?? (issue ? `条件を提示できません：${issue}` : `相手国の予想される回答：${assessment.accepts ? "現在の条件なら受諾の見込み" : "Likely refusal"}. ${assessment.reason}`);
    root.querySelector<HTMLButtonElement>('[data-peace-action="propose"]')!.disabled = !!issue;
    const accept = root.querySelector<HTMLButtonElement>('[data-peace-action="accept"]')!;
    accept.disabled = !!separateIssue || !!getPeaceTermsIssue(world, b, a, opponent.terms); accept.dataset.peaceRevision = String(opponent.revision);
  };
  root.addEventListener("input", (event) => { if ((event.target as HTMLElement).dataset.peaceControl !== "automatic") { dirty = true; update(); } });
  root.addEventListener("change", (event) => {
    const input = event.target as HTMLInputElement;
    if (input.dataset.peaceControl === "automatic") {
      const war = findWar(world.wars, selected(), partner()); if (war && getManualGovernmentId(world) !== selected()) getWarNegotiation(world, war).automatic.set(selected(), input.checked);
    } else dirty = true;
    update();
  });
  root.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-peace-action]"); if (!button) return;
    event.stopPropagation(); const a = selected(), b = partner();
    if (button.dataset.peaceAction === "map") { const map = getMapView(world), terms = read(); map.territoryPreviewIds = [...terms.demandedRegionIds, ...terms.offeredRegionIds, ...(terms.partition?.districtIds ?? [])]; map.revision++; return; }
    if (button.dataset.peaceAction === "release") {
      const released = releaseSubjectGovernment(world, a, b);
      feedback(released ? "独立を認めました。軍事通行権の共有を終了しました。" : "相手国はすでに従属国ではありません。");
      update();
      return;
    }
    if (button.dataset.peaceAction === "subject-assimilation" || button.dataset.peaceAction === "subject-autonomy" || button.dataset.peaceAction === "integrate") {
      const action = button.dataset.peaceAction;
      const success = action === "integrate" ? integrateSubjectGovernment(world, a, b) :
        getSubjectOverlord(world, b) === a && setGovernancePolicy(world, a, b, action === "subject-assimilation" ? "assimilation" : "autonomy");
      feedback(success ? action === "integrate" ? "従属国を統合しました。" : "従属国の統治政策を変更しました。" : "現在は従属国に対してこの操作を行えません。");
      update();
      return;
    }
    let success = false;
    if (button.dataset.peaceAction === "propose") { success = proposePeaceTerms(world, a, b, read()); if (success) dirty = false; }
    if (button.dataset.peaceAction === "accept") success = acceptPeaceOffer(world, a, b, Number(button.dataset.peaceRevision));
    if (success && button.dataset.peaceAction === "accept" && getSubjectOverlord(world, a) === b) {
      feedback(`Peace signed. ${getNationName(world, a)} is now a subject of ${getNationName(world, b)}.`);
      update();
      return;
    }
    feedback(success ? button.dataset.peaceAction === "accept" ? "講和が成立し、領土、賠償、休戦の合意が発効しました。" : "講和条件を提示しました。相手国は情勢に応じて判断します。" : "この合意はすでに無効です。領土、資源、戦況を確認してください。"); update();
  });
  return { update };
}
