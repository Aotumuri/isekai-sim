import { getDesignTransportCapacity } from "../sim/unit-capabilities";
import { getIdeologicalAffinity, ideologyAffinityLabel } from "../sim/ideology-relations";
import { attachExileControls } from "./exile-controls";
import { attachMilitaryCooperationControls } from "./military-cooperation-controls";
import { attachMobilizationControls } from "./mobilization-controls";
import { attachTerritoryControls, districtName } from "./territory-controls";
import { attachFactionControls } from "./faction-controls";
import { getNationName, getNationIdeology } from "../sim/nation-identity";
import { getMapView, setMapMode, selectMapNation } from "../render/map-view-state";
import type { NationId } from "../worldgen/nation";
import { getNationCharacter } from "../sim/nation-character";
import { breakTreaty, improveRelations, proposeTreaty, relationKey } from "../sim/diplomacy";
import { openDiplomaticCrisis, respondToCrisis } from "../sim/diplomatic-crises";
import { findWar } from "../sim/war-state";
import { offerPeace } from "../sim/diplomatic-peace";
import { sendArmsAid } from "../sim/arms-aid";
import { refitUnit } from "../sim/equipment-development";
import { proposeResourceTrade, TRADE_RESOURCE_VALUES, type TradeResource } from "../sim/international-trade";
import { getNationalDesign, getResearchCost, getResearchPortfolio, getEquipmentResearchPriorities, getNationalResearchSummary, EQUIPMENT_FAMILIES, EQUIPMENT_FAMILY_NAMES, FAMILY_RESEARCH_BRANCHES, RESEARCH_BRANCH_NAMES, type EquipmentFamily, type ResearchPriority,
  type ResearchBranch, type ResearchPortfolio } from "../sim/research";
import { createSimulationSettings, getWarDeclarationMode } from "../sim/simulation-settings";
import { licenseTechnology } from "../sim/technology-exchange";
import { isNationActive, isNationPresent } from "../sim/nation-active";
import type { SimClock } from "../sim/time";
import type { WorldState } from "../sim/world-state";

const BRANCH_NAMES = RESEARCH_BRANCH_NAMES;
const DOCTRINES = { expansionist: "Expansionist", merchant: "Mercantile", technocrat: "Technocratic",
  guardian: "Defensive", pragmatist: "Pragmatic", isolationist: "Isolationist" };
const TREATY_NAMES = { alliance: "Defensive alliance", trade: "Trade pact", "non-aggression": "Non-aggression", truce: "Truce" };
const RESOURCE_NAMES: Record<TradeResource, string> = { steel: "Steel", fuel: "Fuel", weapons: "Weapons" };
const RESEARCH_STATUS = { researching: "Researching", "saving resources": "Saving research funds", "capital isolated": "Capital isolated", complete: "Research complete", paused: "Preparing", "government in exile": "Government in exile" };
const esc = (value: unknown) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));

export function attachSocietyPanel(root: HTMLElement, world: WorldState, clock: SimClock): { update: () => void; openDiplomacy: () => void; openFactions: () => void; close: () => void } {
  const wrapper = document.createElement("div"); wrapper.className = "society-ui";
  const branchOptions = FAMILY_RESEARCH_BRANCHES.Infantry.map((branch) => `<option value="${branch}">${BRANCH_NAMES[branch]}</option>`).join("");
  const familyOptions = EQUIPMENT_FAMILIES.map((family) => `<option value="${family}">${EQUIPMENT_FAMILY_NAMES[family]}</option>`).join("");
  const resourceOptions = Object.entries(RESOURCE_NAMES).map(([value, label]) => `<option value="${value}">${label}</option>`).join("");
  wrapper.innerHTML = `
    <div class="society-launch"><button type="button" data-action="toggle" aria-expanded="false" aria-controls="society-panel">Diplomacy & Research <kbd>I</kbd></button><button type="button" data-action="pause" aria-label="Pause">Pause <kbd>P</kbd></button></div>
    <section id="society-panel" class="society-panel" aria-label="Diplomacy and research" hidden>
      <header><div><span class="society-eyebrow">NATIONS & IDEAS</span><h1>Diplomacy & Research</h1></div><button type="button" data-action="close" aria-label="Close diplomacy and research">Close ×</button></header>
      <details class="society-settings"><summary>Simulation settings</summary>
        <label><input type="checkbox" data-setting="diplomacyEnabled"> Diplomacy (overrides legacy war declarations)</label>
        <label><input type="checkbox" data-setting="legacyWarDeclarationsEnabled"> Legacy war declarations (when diplomacy is off)</label>
        <label><input type="checkbox" data-setting="mobilizationEnabled"> Mobilization and civilian strain</label>
        <label><input type="checkbox" data-setting="researchEnabled"> National research and automatic refits</label>
        <label><input type="checkbox" data-setting="armsAidEnabled"> Arms aid</label>
        <label><input type="checkbox" data-setting="tradeEnabled"> Resource trade</label>
        <p data-view="mode"></p>
      </details>
      <div class="society-selectors"><label>Selected nation<select data-control="nation" aria-label="Selected nation"></select></label><label>Diplomatic partner<select data-control="partner" aria-label="Diplomatic partner"></select></label></div>
      <div class="society-country" data-view="country"></div><div data-exile-ui></div>
      <nav class="society-tabs" aria-label="Information views"><button type="button" data-tab="diplomacy" aria-pressed="true">Diplomacy</button><button type="button" data-tab="territory" aria-pressed="false">Territories</button><button type="button" data-tab="military" aria-pressed="false">Military</button><button type="button" data-tab="research" aria-pressed="false">Research</button><button type="button" data-tab="factions" aria-pressed="false">Factions</button><button type="button" data-tab="history" aria-pressed="false">World history</button></nav>
      <p class="society-feedback" role="status" aria-live="polite">Nations act autonomously. Select a nation to guide its policies and diplomacy.</p>
      <section data-pane="diplomacy">
        <div data-view="relation"></div>
        <div class="society-actions"><button type="button" data-action="improve" title="10 influence. Opinion +10, trust +3, tension -8.">Send envoy · 10</button><button type="button" data-action="pact" title="Requires opinion 20, trust 30 and influence 12.">Non-aggression · 12</button><button type="button" data-action="trade-pact" title="Requires opinion 10, trust 30 and influence 8.">Trade pact · 8</button><button type="button" data-action="alliance" title="Requires opinion 55, trust 55 and influence 20.">Defensive alliance · 20</button></div>
        <label>Aid equipment<select data-control="aid-family" aria-label="Aid equipment">${familyOptions}</select></label><div class="society-actions"><button type="button" data-action="aid" title="Send equipment for the selected weapon family and retain a reserve of 30. Requires friendly relations and an open route.">Send 20 weapons</button><button type="button" data-action="peace" title="A recent war or a decisive advantage can prevent a negotiated peace.">Offer peace</button><button type="button" data-action="crisis" class="society-danger" title="12 influence. Treaties, strategic access and military strength constrain ultimatums.">Ultimatum · 12</button></div>
        <div data-view="crisis"></div>
        <details><summary>Break a treaty (damages trust and opinion)</summary><div class="society-actions"><button type="button" data-action="break-alliance">Break alliance</button><button type="button" data-action="break-pact">Break non-aggression</button><button type="button" data-action="break-trade">Break trade pact</button></div></details>
        <div data-military-cooperation-ui></div>
        <h2>Resource exchange</h2><p class="society-note">Exchange equal value. Exports are reserved at dispatch and arrive after transit.</p>
        <div class="society-trade-form"><label>Export<select data-control="export" aria-label="Export resource">${resourceOptions}</select></label><label>Amount<input data-control="amount" aria-label="Export quantity" type="number" min="1" max="50" value="12" step="1"></label><label>Import<select data-control="import" aria-label="Import resource">${resourceOptions}</select></label><button type="button" data-action="exchange">Propose exchange</button></div><p class="society-note" data-view="exchange"></p>
        <div data-view="shipments"></div><h2>Relations</h2><div data-view="relations"></div>
      </section>
      <section data-pane="territory" hidden><div data-territory-ui></div></section>
      <section data-pane="military" hidden><div data-mobilization-ui></div></section>
      <section data-pane="research" hidden>
        <p class="society-note">One national research budget is shared by all equipment programs. Choose a program, set its priority, and select the improvement to emphasize. Pausing a program preserves its progress.</p>
        <div class="research-programs" data-view="research-programs" aria-label="Equipment research programs"></div>
        <div class="society-selectors"><label>Equipment program<select data-control="research-family" aria-label="Equipment research program">${familyOptions}</select></label>
        <label>Program priority<select data-control="research-priority" aria-label="Equipment research priority"><option value="auto">Automatic: national personality</option><option value="paused">Paused</option><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option></select></label></div>
        <div class="society-selectors"><label>Research focus<select data-control="focus" aria-label="Research focus"><option value="auto">Automatic: personality and circumstances</option>${branchOptions}</select></label><label>National research budget<select data-control="investment" aria-label="Research budget"><option value="economy">Economy (0.5×)</option><option value="balanced">Balanced (1×)</option><option value="ambitious">Ambitious (1.5×)</option></select></label></div>
        <p class="society-note" data-view="research-status"></p><div data-view="research"></div>
        <p class="society-note" data-view="program-description"></p><h2 data-view="design-title">Latest domestic design</h2><div class="society-design" data-view="design"></div><p class="society-note">Firepower, protection, speed and payload have cost, fuel, weight or reliability penalties. Efficiency research offsets them. New units receive their own family’s design; existing units refit gradually at supplied facilities.</p>
        <div class="society-actions"><button type="button" data-action="refit">Refit up to 2 units in this program</button></div>
        <h2>Technology licensing</h2><div class="society-trade-form"><label>Technology to license<select data-control="license" aria-label="Licensed technology">${branchOptions}</select></label><button type="button" data-action="license">License to selected partner</button></div><p class="society-note">Licenses the selected equipment program only. Requires an alliance or trade pact, trust 55 and a technology advantage. Costs 5 influence; the partner pays 4 weapons and 2 steel to accelerate its research.</p>
      </section>
      <section data-pane="factions" hidden><div data-faction-ui></div></section>
      <section data-pane="history" hidden><div class="society-events" data-view="events"></div><p class="society-note">The latest 200 events are retained; the newest 40 are shown here.</p></section>
    </section>`;
  root.appendChild(wrapper);
  const n = (id: NationId) => esc(getNationName(world, id));
  const panel = wrapper.querySelector<HTMLElement>("#society-panel")!;
  const view = (name: string) => wrapper.querySelector<HTMLElement>(`[data-view="${name}"]`)!;
  const control = (name: string) => wrapper.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-control="${name}"]`)!;
  const nationSelect = control("nation") as HTMLSelectElement, partnerSelect = control("partner") as HTMLSelectElement;
  (control("import") as HTMLSelectElement).value = "weapons";
  const feedback = wrapper.querySelector<HTMLElement>(".society-feedback")!;
  const exileControls = attachExileControls(wrapper.querySelector<HTMLElement>("[data-exile-ui]")!, world, () => nationSelect.value as NationId, (id) => { selectMapNation(world, id); nationSelect.value = id; update(true); });
  const factions = attachFactionControls(wrapper.querySelector<HTMLElement>("[data-faction-ui]")!, world, () => nationSelect.value as NationId, (message) => { feedback.textContent = message; update(true); });
  const territories = attachTerritoryControls(wrapper.querySelector<HTMLElement>("[data-territory-ui]")!, world, () => nationSelect.value as NationId, () => partnerSelect.value as NationId, (message) => { feedback.textContent = message; update(true); });
  const mobilizationControls = attachMobilizationControls(wrapper.querySelector<HTMLElement>("[data-mobilization-ui]")!, world, () => nationSelect.value as NationId, (message) => { feedback.textContent = message; update(true); });
  const militaryCooperation = attachMilitaryCooperationControls(wrapper.querySelector<HTMLElement>("[data-military-cooperation-ui]")!, world, () => nationSelect.value as NationId, () => partnerSelect.value as NationId, (message) => { feedback.textContent = message; update(true); });
  let visible = false, lastRender = -Infinity, cachedNationIds = "";
  let researchOptionFamily = "";
  let lastPaused: boolean | undefined;
  let lastSelected: NationId | null = null, lastTarget: NationId | null = null;
  const setVisible = (next: boolean) => {
    visible = next; panel.hidden = !next;
    if (!next) territories.clearPreview();
    wrapper.querySelector("[data-action=toggle]")!.setAttribute("aria-expanded", String(next));
    if (next) update(true);
  };
  const setText = (name: string, text: string) => { view(name).textContent = text; };

  const update = (force = false) => {
    const pause = wrapper.querySelector<HTMLElement>("[data-action=pause]")!;
    if (lastPaused !== Boolean(clock.paused)) {
      lastPaused = Boolean(clock.paused);
      pause.innerHTML = `${clock.paused ? "Resume" : "Pause"} <kbd>P</kbd>`;
      pause.setAttribute("aria-label", clock.paused ? "Resume" : "Pause");
    }
    if (!visible || (!force && performance.now() - lastRender < 750)) return;
    lastRender = performance.now();
    const active = world.nations.filter((nation) => isNationPresent(world, nation)), ids = active.map((nation) => `${nation.id}:${world.exileGovernments?.byNationId.get(nation.id)?.status ?? "home"}`).join("|");
    if (ids !== cachedNationIds) {
      const a = nationSelect.value, b = partnerSelect.value;
      const options = active.map((nation) => `<option value="${esc(nation.id)}">${n(nation.id)}${world.exileGovernments?.byNationId.get(nation.id)?.status === "exiled" ? " (in exile)" : ""}</option>`).join("");
      nationSelect.innerHTML = options; partnerSelect.innerHTML = options;
      nationSelect.value = active.some((nation) => nation.id === a) ? a : active[0]?.id ?? "";
      partnerSelect.value = active.some((nation) => nation.id === b && nation.id !== nationSelect.value) ? b : active.find((nation) => nation.id !== nationSelect.value)?.id ?? "";
      cachedNationIds = ids;
    }
    const map = getMapView(world);
    const actor = map.mode === "diplomacy" ? map.diplomaticFocusId : map.selectedNationId;
    if (actor !== lastSelected && active.some((nation) => nation.id === actor)) {
      nationSelect.value = actor!; lastSelected = actor;
    }
    if (map.targetNationId !== lastTarget && active.some((nation) => nation.id === map.targetNationId)) {
      partnerSelect.value = map.targetNationId!; lastTarget = map.targetNationId;
    }
    if (nationSelect.value === partnerSelect.value) partnerSelect.value = active.find((nation) => nation.id !== nationSelect.value)?.id ?? "";
    const a = nationSelect.value as NationId, b = partnerSelect.value as NationId;
    const nation = active.find((item) => item.id === a);
    if (!nation) { setText("country", "No active nations remain."); return; }
    const settings = world.settings ?? createSimulationSettings({ diplomacyEnabled: false });
    for (const input of wrapper.querySelectorAll<HTMLInputElement>("[data-setting]")) {
      input.checked = settings[input.dataset.setting as keyof typeof settings];
      input.disabled = input.dataset.setting === "legacyWarDeclarationsEnabled" && settings.diplomacyEnabled;
    }
    const mode = getWarDeclarationMode(world);
    setText("mode", `War declaration mode: ${mode === "diplomacy" ? "Diplomacy (legacy declarations disabled)" : mode === "legacy" ? "Legacy war declarations" : "No automatic declarations"}`);
    const character = getNationCharacter(world, a), relation = world.diplomacy?.relations.get(relationKey(a, b));
    view("country").innerHTML = `<strong>${n(a)}</strong><span>${DOCTRINES[character.doctrine]} · ${esc(getNationIdeology(world, a).name)} · Influence ${Math.floor(world.diplomacy?.influenceByNationId.get(a) ?? 30)}</span><small>Steel ${Math.floor(nation.resources.steel)} / Fuel ${Math.floor(nation.resources.fuel)} / Weapons ${Math.floor(nation.resources.weapons)}</small>`;
    const treaties = relation?.treaties.filter((treaty) => treaty.expiresAtSlowTick > world.time.slowTick) ?? [];
    view("relation").innerHTML = `<h2>${n(b)} — relations</h2><p class="society-note">Ideologies: ${esc(getNationIdeology(world, a).name)} ↔ ${esc(getNationIdeology(world, b).name)} · ${ideologyAffinityLabel(getIdeologicalAffinity(world, a, b))}</p>${findWar(world.wars, a, b) ? '<p class="society-note">At war</p>' : ""}${relation ? `<div class="society-metrics"><span>Opinion <b>${Math.round(relation.opinion)}</b></span><span>Trust <b>${Math.round(relation.trust)}</b></span><span>Tension <b>${Math.round(relation.tension)}</b></span></div><p class="society-note">${treaties.map((treaty) => `${TREATY_NAMES[treaty.type]} (${treaty.expiresAtSlowTick - world.time.slowTick}s remaining)`).join(" / ") || "No treaties"}</p>` : '<p class="society-note">No diplomatic relation history yet.</p>'}`;
    const crisis = relation?.crisis;
    view("crisis").innerHTML = crisis ? `<div class="society-crisis">Ultimatum: ${n(crisis.aggressorId)} → ${n(crisis.aggressorId === a ? b : a)}${crisis.demand === "territory" ? `<br>Demands: ${(crisis.regionIds ?? []).map(districtName).join(", ")}` : ""}<br>Negotiation deadline: ${Math.max(0, crisis.deadlineSlowTick - world.time.slowTick)}s${crisis.aggressorId !== a ? `<div class="society-actions"><button type="button" data-action="negotiate">Negotiate · 15</button><button type="button" data-action="concede">${crisis.demand === "territory" ? "Accept territorial demand" : "Concede 30 weapons"}</button><button type="button" data-action="reject">Reject</button></div>` : ""}</div>` : "";
    const offered = control("export").value as TradeResource, requested = control("import").value as TradeResource;
    const amount = Number(control("amount").value);
    setText("exchange", `${Number.isFinite(amount) ? amount : 0} ${RESOURCE_NAMES[offered]} ↔ ${(Number.isFinite(amount) ? amount * TRADE_RESOURCE_VALUES[offered] / TRADE_RESOURCE_VALUES[requested] : 0).toFixed(1)} ${RESOURCE_NAMES[requested]}. Requires an agreement, open route and surplus resources.`);
    const trades = (world.internationalTrade?.deals ?? []).filter((deal) => deal.sellerId === a || deal.buyerId === a).slice(-4);
    const aid = (world.armsAid?.shipments ?? []).filter((shipment) => shipment.donorId === a || shipment.recipientId === a).slice(-3);
    const statusName = { "in-transit": "In transit", delivered: "Delivered", returned: "Returned" };
    view("shipments").innerHTML = `<h2>Trade and aid shipments</h2>${trades.map((deal) => `<p class="society-note">${n(deal.sellerId)} ↔ ${n(deal.buyerId)}：${RESOURCE_NAMES[deal.offeredResource]} ${deal.offeredAmount.toFixed(1)} / ${RESOURCE_NAMES[deal.requestedResource]} ${deal.requestedAmount.toFixed(1)} · ${statusName[deal.status]}${deal.status === "in-transit" ? ` (${Math.max(0, deal.arrivesAtSlowTick - world.time.slowTick)}s remaining)` : ""}</p>`).join("")}${aid.map((shipment) => `<p class="society-note">${n(shipment.donorId)} → ${n(shipment.recipientId)}：Weapons ${shipment.weapons} · ${statusName[shipment.status]}</p>`).join("")}${trades.length + aid.length === 0 ? '<p class="society-note">No shipments yet.</p>' : ""}`;
    view("relations").innerHTML = `<table><thead><tr><th>Partner</th><th>Opinion</th><th>Treaties</th></tr></thead><tbody>${active.filter((item) => item.id !== a).map((other) => {
      const item = world.diplomacy?.relations.get(relationKey(a, other.id));
      return `<tr><td><button type="button" data-action="partner" data-partner="${esc(other.id)}">${n(other.id)}</button></td><td>${item ? Math.round(item.opinion) : "No contact"}</td><td>${item?.treaties.filter((treaty) => treaty.expiresAtSlowTick > world.time.slowTick).map((treaty) => TREATY_NAMES[treaty.type]).join(" / ") || "—"}</td></tr>`;
    }).join("")}</tbody></table>`;
    const family = control("research-family").value as EquipmentFamily;
    const portfolio = getResearchPortfolio(world, a, family), national = getResearchPortfolio(world, a);
    if (researchOptionFamily !== family) {
      const options = FAMILY_RESEARCH_BRANCHES[family].map((branch) => `<option value="${branch}">${BRANCH_NAMES[branch]}</option>`).join("");
      control("focus").innerHTML = `<option value="auto">Automatic: personality and circumstances</option>${options}`;
      control("license").innerHTML = options; researchOptionFamily = family;
    }
    if (document.activeElement !== control("focus")) control("focus").value = portfolio.focus;
    if (document.activeElement !== control("investment")) control("investment").value = national.investment;
    if (document.activeElement !== control("research-priority")) control("research-priority").value = portfolio.priority ?? "auto";
    const summary = getNationalResearchSummary(world, a), weights = getEquipmentResearchPriorities(world, a);
    const totalWeight = Object.values(weights).reduce((sum, value) => sum + value, 0);
    view("research-programs").innerHTML = EQUIPMENT_FAMILIES.map((type) => {
      const program = getResearchPortfolio(world, a, type), share = totalWeight ? (weights[type] / totalWeight * 100).toFixed(1) : "0.0";
      return `<button type="button" data-research-family="${type}" aria-pressed="${type === family}"><strong>${EQUIPMENT_FAMILY_NAMES[type]}</strong><span>${esc(program.priority ?? "auto")} · ${share}% allocation</span><small>${program.completedProjects} projects · last ${program.lastScience.toFixed(2)}/s</small></button>`;
    }).join("");
    setText("research-status", `${settings.researchEnabled ? RESEARCH_STATUS[portfolio.status] : "Research paused"} · ${EQUIPMENT_FAMILY_NAMES[family]} focus: ${BRANCH_NAMES[portfolio.focus === "auto" ? portfolio.primaryBranch : portfolio.focus]} · Last science: program ${portfolio.lastScience.toFixed(2)}/s / nation ${summary.lastScience.toFixed(2)}/s · Completed ${summary.completedProjects} projects`);
    view("research").innerHTML = FAMILY_RESEARCH_BRANCHES[family].map((branch) => {
      const cost = getResearchCost(portfolio, branch), percent = portfolio.levels[branch] >= 10 ? 100 : Math.min(100, portfolio.progress[branch] / cost * 100);
      return `<div class="society-research-row"><span>${BRANCH_NAMES[branch]}</span><b>Lv.${portfolio.levels[branch]}</b><progress aria-label="${BRANCH_NAMES[branch]} research progress" max="100" value="${percent}"></progress><small>${Math.floor(percent)}%</small></div>`;
    }).join("");
    setText("program-description", {
      Infantry: "Small arms: improve firepower, accuracy and handling, or reliability. Better handling improves effective fire and organization recovery; precision weapons cost more to manufacture.",
      Tank: "Tanks: emphasize firepower, protection or speed. Armor reduces received damage but adds weight and fuel demand. Faster engines consume more fuel and require reliability improvements.",
      CombatShip: "Warships: choose stronger guns, tougher protection or higher speed. Armor slows the ship; powerful guns and engines increase operating costs. Efficiency and reliability research offset these penalties.",
      TransportShip: "Transport ships: expand cargo capacity, improve survivability or increase speed. Capacity gains diminish: a standard 10-unit ship reaches at most 25 units at level 10. Larger hulls cost more, burn more fuel and move more slowly.",
    }[family]);
    exileControls.update();
    factions.update();
    territories.update();
    mobilizationControls.update();
    militaryCooperation.update();
    const design = getNationalDesign(world, a, family);
    setText("design-title", `${EQUIPMENT_FAMILY_NAMES[family]} · Domestic design generation ${design.generation}`);
    const stats: [string, string][] = [["Reliability", `×${design.reliability.toFixed(2)}`], ["Weapons required", `×${design.weaponCost.toFixed(2)}`], ["Organization recovery", `×${design.recovery.toFixed(2)}`]];
    if (family !== "TransportShip") stats.unshift(["Firepower", `×${design.firepower.toFixed(2)}`]);
    if (family === "Infantry") stats.push(["Accuracy & handling", `×${(design.handling ?? 1).toFixed(2)}`]);
    else stats.push(["Protection", `×${(design.armor ?? 1).toFixed(2)}`], ["Speed", `×${(design.mobility ?? 1).toFixed(2)}`], ["Fuel use", `×${design.fuelUse.toFixed(2)}`]);
    if (family === "TransportShip") stats.push(["Cargo capacity", `${getDesignTransportCapacity(design)} units`]);
    view("design").innerHTML = stats.map(([label, value]) => `<span>${label}<strong>${value}</strong></span>`).join("");
    view("events").innerHTML = [...(world.events ?? [])].slice(-40).reverse().map((event) => `<article class="society-event"><time>${Math.floor(event.tick / 600)}:${String(Math.floor(event.tick / 10) % 60).padStart(2, "0")}</time><span>${esc(event.message)}</span></article>`).join("") || '<p class="society-note">Diplomacy, trade, research and mobilization events appear here.</p>';
    for (const button of panel.querySelectorAll<HTMLButtonElement>("button[data-action]")) {
      const action = button.dataset.action;
      if (["improve", "pact", "trade-pact", "alliance", "aid", "peace", "crisis", "negotiate", "concede", "reject", "break-alliance", "break-pact", "break-trade", "exchange", "license"].includes(action ?? "")) {
        button.disabled = mode !== "diplomacy" || a === b || !active.some((item) => item.id === b) ||
          (action === "aid" && !settings.armsAidEnabled) || (action === "exchange" && !settings.tradeEnabled) ||
          (action === "license" && !settings.researchEnabled) ||
          (["aid", "peace", "crisis", "negotiate", "concede", "reject", "exchange", "license"].includes(action ?? "") &&
            (!isNationActive(nation) || !active.some((item) => item.id === b && isNationActive(item))));
      }
      if (action === "refit") button.disabled = !settings.researchEnabled || !isNationActive(nation);
    }
  };

  wrapper.addEventListener("change", (event) => {
    const target = event.target as HTMLInputElement;
    if (target.dataset.setting) {
      world.settings ??= createSimulationSettings();
      world.settings[target.dataset.setting as keyof typeof world.settings] = target.checked;
      feedback.textContent = "Settings updated. Existing wars continue; shipments are checked on the next evaluation.";
    } else if (["focus", "investment", "research-priority"].includes(target.dataset.control ?? "")) {
      const portfolio = getResearchPortfolio(world, nationSelect.value as NationId, control("research-family").value as EquipmentFamily);
      if (target.dataset.control === "focus") portfolio.focus = target.value as ResearchPortfolio["focus"];
      else if (target.dataset.control === "research-priority") portfolio.priority = target.value as ResearchPriority;
      else getResearchPortfolio(world, nationSelect.value as NationId).investment = target.value as ResearchPortfolio["investment"];
      feedback.textContent = "Research policy updated for the next evaluation. Existing progress is preserved.";
    } else if (target.dataset.control === "nation") {
      selectMapNation(world, nationSelect.value as NationId);
      if (nationSelect.value === partnerSelect.value) partnerSelect.value = world.nations.find((nation) => isNationActive(nation) && nation.id !== nationSelect.value)?.id ?? "";
    }
    update(true);
  });
  wrapper.addEventListener("input", (event) => { if ((event.target as HTMLElement).dataset.control === "amount") update(true); });
  wrapper.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button");
    if (!button) return;
    if (button.dataset.researchFamily) { control("research-family").value = button.dataset.researchFamily; update(true); return; }
    if (button.dataset.tab) {
      if (button.dataset.tab !== "territory") territories.clearPreview();
      if (button.dataset.tab === "factions") setMapMode(world, "factions");
      for (const pane of wrapper.querySelectorAll<HTMLElement>("[data-pane]")) pane.hidden = pane.dataset.pane !== button.dataset.tab;
      for (const tab of wrapper.querySelectorAll<HTMLElement>("[data-tab]")) tab.setAttribute("aria-pressed", String(tab === button));
      update(true); return;
    }
    const action = button.dataset.action;
    if (action === "toggle" || action === "close") { setVisible(action === "toggle" ? !visible : false); return; }
    if (action === "pause") { clock.paused = !clock.paused; update(true); return; }
    if (action === "partner") { partnerSelect.value = button.dataset.partner!; update(true); return; }
    const a = nationSelect.value as NationId, b = partnerSelect.value as NationId;
    let success = false;
    if (action === "improve") success = improveRelations(world, a, b);
    else if (action === "pact") success = proposeTreaty(world, a, b, "non-aggression");
    else if (action === "trade-pact") success = proposeTreaty(world, a, b, "trade");
    else if (action === "alliance") success = proposeTreaty(world, a, b, "alliance");
    else if (action === "aid") success = sendArmsAid(world, a, b, 20, control("aid-family").value as EquipmentFamily);
    else if (action === "peace") success = offerPeace(world, a, b);
    else if (action === "crisis") success = openDiplomaticCrisis(world, a, b);
    else if (action === "negotiate" || action === "concede" || action === "reject") success = respondToCrisis(world, a, b, action);
    else if (action === "break-alliance") success = breakTreaty(world, a, b, "alliance");
    else if (action === "break-pact") success = breakTreaty(world, a, b, "non-aggression");
    else if (action === "break-trade") success = breakTreaty(world, a, b, "trade");
    else if (action === "exchange") {
      const offered = control("export").value as TradeResource, requested = control("import").value as TradeResource, amount = Number(control("amount").value);
      success = proposeResourceTrade(world, a, b, offered, amount, requested, amount * TRADE_RESOURCE_VALUES[offered] / TRADE_RESOURCE_VALUES[requested]);
    } else if (action === "license") success = licenseTechnology(world, a, b, control("license").value as ResearchBranch, control("research-family").value as EquipmentFamily);
    else if (action === "refit") {
      let count = 0;
      for (const unit of world.units.filter((item) => item.nationId === a && item.type === control("research-family").value)) if (count < 2 && refitUnit(world, unit.id)) count += 1;
      success = count > 0;
    }
    feedback.textContent = success ? "Action completed. Relations, resources, shipments and history have been updated." :
      "Requirements are not met. Check influence, relations, agreements, reserves and routes. Refits require an improved design and a supplied facility.";
    update(true);
  });
  window.addEventListener("keydown", (event) => {
    if (event.code === "Escape" && visible) { setVisible(false); return; }
    if (event.repeat || (event.target instanceof HTMLElement && (event.target.isContentEditable || event.target.closest("input,select,textarea,button")))) return;
    if (event.code === "KeyI") { event.preventDefault(); setVisible(!visible); }
    if (event.code === "KeyP") { event.preventDefault(); clock.paused = !clock.paused; update(true); }

  });
  const openPane = (name: string) => {
    setVisible(true);
    for (const pane of wrapper.querySelectorAll<HTMLElement>("[data-pane]")) pane.hidden = pane.dataset.pane !== name;
    for (const tab of wrapper.querySelectorAll<HTMLElement>("[data-tab]")) tab.setAttribute("aria-pressed", String(tab.dataset.tab === name));
    update(true);
  };
  return { update: () => update(), openDiplomacy: () => openPane("diplomacy"), openFactions: () => openPane("factions"), close: () => setVisible(false) };
}
