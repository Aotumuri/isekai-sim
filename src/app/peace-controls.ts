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
  root.innerHTML = `<details open data-peace-panel><summary>Peace negotiations</summary><p class="society-note" data-peace-view="outlook"></p>
    <p class="society-note" data-peace-view="deliveries"></p><div data-peace-view="subject"></div><div class="peace-offers" data-peace-view="offers"></div><div data-peace-editor>
    <label><input type="checkbox" data-peace-control="automatic" checked> Let the AI revise and accept peace terms</label>
    <p class="society-note">Both governments maintain standing terms from the start of war. Battle losses, occupation, fatigue and domestic unrest change willingness to accept. Publishing your own terms switches this government's negotiations to manual control.</p>
    <div class="society-selectors"><label>Demand provinces<select multiple size="4" data-peace-control="demand" aria-label="Peace demanded provinces"></select></label><label>Offer provinces<select multiple size="4" data-peace-control="offer" aria-label="Peace offered provinces"></select></label></div>
    <div class="society-selectors"><label>Demand weapons<input type="number" min="0" max="100" step="1" value="0" data-peace-control="demand-weapons" aria-label="Peace demanded weapons"></label><label>Offer weapons<input type="number" min="0" max="100" step="1" value="0" data-peace-control="offer-weapons" aria-label="Peace offered weapons"></label></div>
    <div class="society-selectors"><label>Resource reparations<select data-peace-control="reparation-resource"><option value="">None</option>${REPARATION_RESOURCES.map((resource) => `<option value="${resource}">${resource}</option>`).join("")}</select></label><label>Units per ${REPARATION_INTERVAL}s<input type="number" min="1" max="10" step="1" value="3" data-peace-control="reparation-amount"></label></div>
    <label><input type="checkbox" data-peace-control="puppet"> Install a puppet government in the opposing country</label>
    <label><input type="checkbox" data-peace-control="partition"> Divide the remainder into two puppet governments</label>
    ${hasPoliticalTurbulence(world) ? '<label><input type="checkbox" data-peace-control="local-subject"> Establish a local subject in the demanded provinces instead of annexing them</label>' : ""}
    <p class="society-note" data-peace-view="puppet"></p>
    <p class="society-note" data-peace-view="governance"></p>
    <label>Truce duration<select data-peace-control="truce" aria-label="Peace truce duration"><option value="300">5 minutes</option><option value="600">10 minutes</option><option value="900">15 minutes</option></select></label>
    <p class="society-note" data-peace-view="preview"></p><div class="society-actions"><button type="button" data-peace-action="propose">Propose peace terms</button><button type="button" data-peace-action="accept">Accept their terms</button><button type="button" data-peace-action="map">Show selected provinces on the map</button></div>
    <p class="society-note">Select provinces on either side with Ctrl / Command. Ceded territory must connect to existing territory or form a complete island. Ordinary cessions preserve remaining borders. Use partition terms to found a second government. Both signatories retain territory. Third-party occupations require a separate settlement. Resources and land change only when an offer is accepted; unrelated wars continue.</p></div></details>`;
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
      : ids.map(districtName)).map(esc).join(", ") || "No territory";
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
  const summary = (offer: PeaceOffer) => `<article class="peace-offer"><strong>${esc(getNationName(world, offer.proposerId))}'s conditions</strong><p>Demands: ${describe(offer.terms.demandedRegionIds)} · ${offer.terms.demandedWeapons} weapons${offer.terms.resourceReparation
    ? ` · ${offer.terms.resourceReparation.amount} ${esc(offer.terms.resourceReparation.resource)} every ${REPARATION_INTERVAL}s during the truce` : ""}</p><p>Offers: ${describe(offer.terms.offeredRegionIds)} · ${offer.terms.offeredWeapons} weapons</p>${offer.terms.partition ? `<p><strong>Two puppet governments</strong> · New capital at ${esc(districtName(offer.terms.partition.capitalId))} · ${offer.terms.partition.districtIds.length} districts in the new state</p>` : offer.terms.puppetTarget ? "<p><strong>Install a puppet government in the opposing country</strong></p>" : offer.terms.localSubject ? "<p><strong>Establish a local subject in the demanded provinces</strong></p>" : ""}<small>Truce ${offer.terms.truceSeconds / 60} min · ${offer.source === "opening" ? "Opening terms" : offer.source === "manual" ? "Manually proposed" : "Revised by government"}</small></article>`;
  const update = () => {
    const a = selected(), b = partner(), war = findWar(world.wars, a, b);
    const enabled = !!war && (war.cause === "player-declaration" || getWarDeclarationMode(world) === "diplomacy");
    editor.hidden = !enabled;
    const delivery = (world.resourceReparations ?? []).find((term) =>
      (term.payerId === a && term.recipientId === b) || (term.payerId === b && term.recipientId === a));
    view("deliveries").textContent = delivery
      ? `${getNationName(world, delivery.payerId)} owes ${delivery.amount} ${delivery.resource} every ${REPARATION_INTERVAL}s. Next delivery in ${Math.max(0, delivery.nextPaymentAt - world.time.slowTick)}s, subject to available stock.` : "";
    const ownOverlord = getSubjectOverlord(world, a);
    const partnerOverlord = getSubjectOverlord(world, b);
    const subjectPolicy = world.nations.find((nation) => nation.id === b)?.governance;
    const integrationIssue = partnerOverlord === a ? getSubjectIntegrationIssue(world, a, b) : undefined;
    const describeSubject = (id: NationId, overlord: NationId | undefined) => overlord
      ? `<p><strong>${esc(getNationName(world, id))}</strong> is a subject of ${esc(getNationName(world, overlord))}. The overlord guarantees its defense and shares military access. Autonomy pressure ${Math.round(world.nations.find((nation) => nation.id === id)?.subjectGovernment?.autonomy ?? 0)}/100.</p>`
      : "";
    view("subject").innerHTML = describeSubject(a, ownOverlord) + (a !== b ? describeSubject(b, partnerOverlord) : "") +
      (partnerOverlord === a ? '<button type="button" data-peace-action="release">Grant independence</button>' : "") +
      (partnerOverlord === a && hasPoliticalTurbulence(world) ? `<p>Subject policy: ${subjectPolicy?.policy ?? "centralized"} · Stability ${Math.round(subjectPolicy?.stability ?? 100)}/100 · Cultural and religious alignment ${Math.round((subjectPolicy?.alignment ?? 0) * 100)}%</p>
        <div class="society-actions"><button type="button" data-peace-action="subject-assimilation">Order assimilation</button><button type="button" data-peace-action="subject-autonomy">Protect regional autonomy</button>
        <button type="button" data-peace-action="integrate" ${integrationIssue ? "disabled" : ""}>Integrate subject</button></div>
        ${integrationIssue ? `<p class="society-note">${esc(integrationIssue)}</p>` : ""}` : "");
    if (!enabled || !war) {
      const signed = [...(world.warNegotiations?.settlements ?? [])].reverse().find((item) =>
        (item.a === a && item.b === b) || (item.a === b && item.b === a));
      view("outlook").textContent = signed ? `Peace signed · ${signed.terms.truceSeconds / 60}-minute truce. Domestic unrest: ${Math.round(getDomesticUnrest(world, a).pressure)}/100. ${world.wars.some((item) => item.nationAId === a || item.nationBId === a) ? "Other wars continue." : "The government can recover in peacetime."}` : getWarDeclarationMode(world) !== "diplomacy" ? "Enable diplomacy to negotiate peace conditions." : "Select a nation currently at war with the diplomatic partner to review peace conditions.";
      view("offers").innerHTML = signed ? summary({ proposerId: signed.proposerId, terms: signed.terms, source: "manual", revisedAtSlowTick: signed.atSlowTick, revision: 0 }) : "";
      key = ""; return;
    }
    const negotiation = getWarNegotiation(world, war), own = negotiation.offers.get(a)!, opponent = negotiation.offers.get(b)!;
    const unrest = getDomesticUnrest(world, a), advantage = getWarAdvantage(world, a, b);
    const trend = getWarTrend(negotiation, a), deadline = getCampaignDeadline(world, a, b);
    const position = advantage > 0.15 ? "Favorable" : advantage < -0.15 ? "Unfavorable" : "Balanced";
    const direction = trend > 0.08 ? "improving" : trend < -0.08 ? "deteriorating" : "steady";
    const window = deadline <= 75 ? ` · Campaign window ~${Math.ceil(deadline)}s` : "";
    view("outlook").textContent = `War outlook: ${position}, ${direction}${window} · Domestic unrest ${Math.round(unrest.pressure)}/100 · War fatigue ${Math.round(getWarFatigue(world, a, b))}/100 · Battle casualties ${Math.round(getWarCasualties(war, a)).toLocaleString()}. ${isFightOnGovernment(world, a) ? "Government favors fighting on despite unrest." : "Government weighs compromise against domestic danger."}`;
    const incoming = assessPeaceOffer(world, a, b, opponent.terms);
    view("offers").innerHTML = summary(own) + summary(opponent) + `<p class="society-note peace-assessment">Your government’s assessment of their terms: ${esc(incoming.reason)}</p>`;
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
          output.push(`<option value="${esc(macro.id)}">Province ${esc(macro.id.replace("macro-", ""))} · ${macro.mesoRegionIds.length} districts${capital ? " · Capital" : ""}${deposits ? ` · ${esc(deposits)}` : ""}</option>`);
          if (!macro.mesoRegionIds.every((regionId) => current.has(regionId))) {
            for (const regionId of macro.mesoRegionIds.filter((item) => current.has(item))) {
              parcels.set(regionId, [regionId]);
              output.push(`<option value="${esc(regionId)}">${esc(districtName(regionId))} · Existing terms</option>`);
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
    view("puppet").textContent = puppetIssue ?? "Puppet governments keep their remaining districts and receive protection. Partition requires the capital and 60% of the remaining districts to be occupied.";
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
    view("preview").textContent = separateIssue ?? (issue ? `Cannot publish: ${issue}` : `Opponent’s expected response to your draft: ${assessment.accepts ? "Acceptable under current conditions" : "Likely refusal"}. ${assessment.reason}`);
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
      feedback(released ? "Independence granted. Shared military access has ended." : "The selected partner is no longer your subject.");
      update();
      return;
    }
    if (button.dataset.peaceAction === "subject-assimilation" || button.dataset.peaceAction === "subject-autonomy" || button.dataset.peaceAction === "integrate") {
      const action = button.dataset.peaceAction;
      const success = action === "integrate" ? integrateSubjectGovernment(world, a, b) :
        getSubjectOverlord(world, b) === a && setGovernancePolicy(world, a, b, action === "subject-assimilation" ? "assimilation" : "autonomy");
      feedback(success ? action === "integrate" ? "Subject integrated." : "Subject governance policy updated." : "The subject cannot take this action now.");
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
    feedback(success ? button.dataset.peaceAction === "accept" ? "Peace signed. Agreed territory, reparations and the truce are in effect." : "Peace conditions published. The other government will reevaluate them as circumstances change." : "The settlement is no longer valid. Review territory, resources and the current war."); update();
  });
  return { update };
}
