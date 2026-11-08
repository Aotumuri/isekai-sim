import { getWholeProvinces } from "../sim/peace-borders";
import type { NationId } from "../worldgen/nation";
import type { MesoRegionId } from "../worldgen/meso-region";
import type { WorldState } from "../sim/world-state";
import { findWar } from "../sim/war-state";
import { getNationName } from "../sim/nation-identity";
import { getMesoById, getOwnerByMesoId } from "../sim/world-cache";
import { getWarDeclarationMode } from "../sim/simulation-settings";
import { getDomesticUnrest } from "../sim/domestic-unrest";
import { getMapView } from "../render/map-view-state";
import { districtName } from "./territory-controls";
import { getWarNegotiation, getWarAdvantage, isFightOnGovernment, getPeaceTermsIssue, assessPeaceOffer, proposePeaceTerms, acceptPeaceOffer, type PeaceTerms, type PeaceOffer } from "../sim/war-negotiations";
const esc = (value: unknown) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));
export function attachPeaceControls(root: HTMLElement, world: WorldState, selected: () => NationId, partner: () => NationId,
  feedback: (message: string) => void): { update: () => void } {
  root.innerHTML = `<details open data-peace-panel><summary>War negotiations</summary><p class="society-note" data-peace-view="outlook"></p>
    <div class="peace-offers" data-peace-view="offers"></div><div data-peace-editor>
    <label><input type="checkbox" data-peace-control="automatic" checked> Automatically revise and accept peace conditions</label>
    <p class="society-note">Both governments maintain standing terms from the start of war. Battle losses, occupation, fatigue and domestic unrest change willingness to accept. Publishing your own terms switches this government's negotiations to manual control.</p>
    <div class="society-selectors"><label>Demand provinces<select multiple size="4" data-peace-control="demand" aria-label="Peace demanded provinces"></select></label><label>Offer provinces<select multiple size="4" data-peace-control="offer" aria-label="Peace offered provinces"></select></label></div>
    <div class="society-selectors"><label>Demand weapons<input type="number" min="0" max="100" step="1" value="0" data-peace-control="demand-weapons" aria-label="Peace demanded weapons"></label><label>Offer weapons<input type="number" min="0" max="100" step="1" value="0" data-peace-control="offer-weapons" aria-label="Peace offered weapons"></label></div>
    <label>Truce duration<select data-peace-control="truce" aria-label="Peace truce duration"><option value="300">5 minutes</option><option value="600">10 minutes</option><option value="900">15 minutes</option></select></label>
    <p class="society-note" data-peace-view="preview"></p><div class="society-actions"><button type="button" data-peace-action="propose">Publish peace conditions</button><button type="button" data-peace-action="accept">Accept opponent's terms</button><button type="button" data-peace-action="map">Preview selected provinces</button></div>
    <p class="society-note">Select up to three whole provinces per side with Ctrl / Command. Ceded territory must connect to existing territory or form a complete island. Remaining territory cannot be split, and neither country can lose its last territory through negotiated peace. Third-party occupations require a separate settlement. Resources and land change only when an offer is accepted; unrelated wars continue.</p></div></details>`;
  const control = (name: string) => root.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-peace-control="${name}"]`)!;
  const view = (name: string) => root.querySelector<HTMLElement>(`[data-peace-view="${name}"]`)!;
  const editor = root.querySelector<HTMLElement>("[data-peace-editor]")!;
  let key = "", revision = -1, dirty = false;
  const parcels = new Map<string, MesoRegionId[]>();
  const values = (name: string) => [...(control(name) as HTMLSelectElement).selectedOptions].flatMap((option) => parcels.get(option.value) ?? []);
  const describe = (ids: MesoRegionId[]) => {
    const owner = getOwnerByMesoId(world).get(ids[0]);
    const provinces = owner ? getWholeProvinces(world, owner, ids) : null;
    return (provinces ? provinces.map((macro) => `Province ${macro.id.replace("macro-", "")}`)
      : ids.map(districtName)).map(esc).join(", ") || "No territory";
  };
  const read = (): PeaceTerms => ({ demandedRegionIds: values("demand"), offeredRegionIds: values("offer"), demandedWeapons: Number(control("demand-weapons").value), offeredWeapons: Number(control("offer-weapons").value), truceSeconds: Number(control("truce").value) });
  const summary = (offer: PeaceOffer) => `<article class="peace-offer"><strong>${esc(getNationName(world, offer.proposerId))}'s conditions</strong><p>Demands: ${describe(offer.terms.demandedRegionIds)} · ${offer.terms.demandedWeapons} weapons</p><p>Offers: ${describe(offer.terms.offeredRegionIds)} · ${offer.terms.offeredWeapons} weapons</p><small>Truce ${offer.terms.truceSeconds / 60} min · ${offer.source === "opening" ? "Opening terms" : offer.source === "manual" ? "Manually proposed" : "Revised by government"}</small></article>`;
  const update = () => {
    const a = selected(), b = partner(), war = findWar(world.wars, a, b);
    const enabled = getWarDeclarationMode(world) === "diplomacy" && !!war;
    editor.hidden = !enabled;
    if (!enabled || !war) {
      const signed = [...(world.warNegotiations?.settlements ?? [])].reverse().find((item) =>
        (item.a === a && item.b === b) || (item.a === b && item.b === a));
      view("outlook").textContent = signed ? `Peace signed · ${signed.terms.truceSeconds / 60}-minute truce. Domestic unrest: ${Math.round(getDomesticUnrest(world, a).pressure)}/100. ${world.wars.some((item) => item.nationAId === a || item.nationBId === a) ? "Other wars continue." : "The government can recover in peacetime."}` : getWarDeclarationMode(world) !== "diplomacy" ? "Enable diplomacy to negotiate peace conditions." : "Select a nation currently at war with the diplomatic partner to review peace conditions.";
      view("offers").innerHTML = signed ? summary({ proposerId: signed.proposerId, terms: signed.terms, source: "manual", revisedAtSlowTick: signed.atSlowTick, revision: 0 }) : "";
      key = ""; return;
    }
    const negotiation = getWarNegotiation(world, war), own = negotiation.offers.get(a)!, opponent = negotiation.offers.get(b)!;
    const unrest = getDomesticUnrest(world, a), advantage = getWarAdvantage(world, a, b);
    view("outlook").textContent = `War outlook: ${advantage > 0.15 ? "Favorable" : advantage < -0.15 ? "Unfavorable" : "Balanced"} · Domestic unrest: ${Math.round(unrest.pressure)}/100 · ${isFightOnGovernment(world, a) ? "Government favors fighting on despite unrest" : "Government weighs compromise against domestic danger"}.`;
    const incoming = assessPeaceOffer(world, a, b, opponent.terms);
    view("offers").innerHTML = summary(own) + summary(opponent) + `<p class="society-note peace-assessment">Your government’s assessment of their terms: ${esc(incoming.reason)}</p>`;
    (control("automatic") as HTMLInputElement).checked = negotiation.automatic.get(a) ?? true;
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
          output.push(`<option value="${esc(macro.id)}">Province ${esc(macro.id.replace("macro-", ""))} · ${macro.mesoRegionIds.length} districts${capital ? " · Capital" : ""}</option>`);
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
      control("truce").value = String(own.terms.truceSeconds); revision = own.revision;
    }
    const terms = read(), issue = getPeaceTermsIssue(world, a, b, terms), assessment = assessPeaceOffer(world, b, a, terms);
    view("preview").textContent = issue ? `Cannot publish: ${issue}` : `Opponent’s expected response to your draft: ${assessment.accepts ? "Acceptable under current conditions" : "Likely refusal"}. ${assessment.reason}`;
    root.querySelector<HTMLButtonElement>('[data-peace-action="propose"]')!.disabled = !!issue;
    const accept = root.querySelector<HTMLButtonElement>('[data-peace-action="accept"]')!;
    accept.disabled = !!getPeaceTermsIssue(world, b, a, opponent.terms); accept.dataset.peaceRevision = String(opponent.revision);
  };
  root.addEventListener("input", (event) => { if ((event.target as HTMLElement).dataset.peaceControl !== "automatic") { dirty = true; update(); } });
  root.addEventListener("change", (event) => {
    const input = event.target as HTMLInputElement;
    if (input.dataset.peaceControl === "automatic") {
      const war = findWar(world.wars, selected(), partner()); if (war) getWarNegotiation(world, war).automatic.set(selected(), input.checked);
    } else dirty = true;
    update();
  });
  root.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-peace-action]"); if (!button) return;
    event.stopPropagation(); const a = selected(), b = partner();
    if (button.dataset.peaceAction === "map") { const map = getMapView(world), terms = read(); map.territoryPreviewIds = [...terms.demandedRegionIds, ...terms.offeredRegionIds]; map.revision++; return; }
    let success = false;
    if (button.dataset.peaceAction === "propose") { success = proposePeaceTerms(world, a, b, read()); if (success) dirty = false; }
    if (button.dataset.peaceAction === "accept") success = acceptPeaceOffer(world, a, b, Number(button.dataset.peaceRevision));
    feedback(success ? button.dataset.peaceAction === "accept" ? "Peace signed. Agreed territory, reparations and the truce are in effect." : "Peace conditions published. The other government will reevaluate them as circumstances change." : "The settlement is no longer valid. Review territory, resources and the current war."); update();
  });
  return { update };
}
