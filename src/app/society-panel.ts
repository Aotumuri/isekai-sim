import { getPlayerNation } from "../sim/player-nation";
import { getPrototypeMaterialRates } from "../sim/research-materials";
import { STRATEGIC_RESOURCE_NAMES, STRATEGIC_RESOURCES } from "../data/strategic-resources";
import { getCrisisDeploymentReadiness } from "../sim/crisis-deployment";
import { attachPeaceConferenceControls } from "./peace-conference-controls";
import { attachFoodControls } from "./food-controls";
import { attachTreasuryControls } from "./treasury-controls";
import { attachPoliticsControls } from "./politics-controls";
import { attachPeaceControls } from "./peace-controls";
import { getDesignTransportCapacity } from "../sim/unit-capabilities";
import { getIdeologicalAffinity, ideologyAffinityLabel } from "../sim/ideology-relations";
import { getPublicOutrage } from "../sim/persecution-reaction";
import { attachExileControls } from "./exile-controls";
import { attachMilitaryCooperationControls } from "./military-cooperation-controls";
import { attachMobilizationControls } from "./mobilization-controls";
import { attachTerritoryControls, districtName } from "./territory-controls";
import { attachFactionControls } from "./faction-controls";
import { getNationName, getNationIdeology } from "../sim/nation-identity";
import { getMapView, setMapMode, selectMapNation } from "../render/map-view-state";
import type { NationId } from "../worldgen/nation";
import { getNationCharacter } from "../sim/nation-character";
import { breakTreaty, extendTruce, getTruceExtensionIssue, improveRelations, proposeTreaty, relationKey, TRUCE_EXTENSION } from "../sim/diplomacy";
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
const DOCTRINES = { expansionist: "拡張主義", merchant: "商業重視", technocrat: "技術重視",
  guardian: "防衛重視", pragmatist: "現実主義", isolationist: "孤立主義" };
const TREATY_NAMES = { alliance: "防衛同盟", trade: "通商条約", "non-aggression": "不可侵条約", truce: "休戦" };
const RESOURCE_NAMES: Record<TradeResource, string> = { ...STRATEGIC_RESOURCE_NAMES, steel: "鋼材", fuel: "燃料", weapons: "武器", food: "食料", cash: "資金" };
const RESEARCH_STATUS = { researching: "研究中", "saving resources": "研究資金を確保中", "capital isolated": "首都が孤立", complete: "研究完了", paused: "準備中", "government in exile": "亡命政府" };
const esc = (value: unknown) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));

export function attachSocietyPanel(root: HTMLElement, world: WorldState, clock: SimClock): { update: () => void; openDiplomacy: () => void; openFactions: () => void; openNegotiations: () => void; setEmbedded: (host: HTMLElement | null) => void; close: () => void } {
  const wrapper = document.createElement("div"); wrapper.className = "society-ui";
  const branchOptions = FAMILY_RESEARCH_BRANCHES.Infantry.map((branch) => `<option value="${branch}">${BRANCH_NAMES[branch]}</option>`).join("");
  const familyOptions = EQUIPMENT_FAMILIES.map((family) => `<option value="${family}">${EQUIPMENT_FAMILY_NAMES[family]}</option>`).join("");
  const resourceOptions = Object.entries(RESOURCE_NAMES).map(([value, label]) => `<option value="${value}">${label}</option>`).join("");
  wrapper.innerHTML = `
    <div class="society-launch"><button type="button" data-action="toggle" aria-expanded="false" aria-controls="society-panel">外交と研究 <kbd>I</kbd></button><button type="button" data-action="pause" aria-label="一時停止">一時停止 <kbd>P</kbd></button></div>
    <section id="society-panel" class="society-panel" aria-label="外交と研究" hidden>
      <header><div><span class="society-eyebrow">国家と思想</span><h1>外交と研究</h1></div><button type="button" data-action="close" aria-label="外交と研究を閉じる">閉じる ×</button></header>
      <details class="society-settings"><summary>シミュレーション設定</summary>
        <label><input type="checkbox" data-setting="diplomacyEnabled"> 外交システム（旧方式の自動宣戦より優先）</label>
        <label><input type="checkbox" data-setting="legacyWarDeclarationsEnabled"> 旧方式の自動宣戦（外交が無効なとき）</label>
        <label><input type="checkbox" data-setting="mobilizationEnabled"> 動員と国民の負担</label>
        <label><input type="checkbox" data-setting="researchEnabled"> 国家研究と自動装備更新</label>
        <label><input type="checkbox" data-setting="armsAidEnabled"> 武器援助</label>
        <label><input type="checkbox" data-setting="tradeEnabled"> 資源取引</label>
        <label><input type="checkbox" data-setting="foodEnabled"> 収穫・配給・飢饉</label>
        <p data-view="mode"></p>
      </details>
      <div class="society-selectors"><label>選択中の国家<select data-control="nation" aria-label="選択中の国家"></select></label><label>外交相手国<select data-control="partner" aria-label="外交相手国"></select></label></div>
      <div class="society-country" data-view="country"></div><div data-exile-ui></div>
      <nav class="society-tabs" aria-label="情報タブ"><button type="button" data-tab="diplomacy" aria-pressed="true">外交</button><button type="button" data-tab="politics" aria-pressed="false">政治</button><button type="button" data-tab="territory" aria-pressed="false">領土</button><button type="button" data-tab="military" aria-pressed="false">軍事</button><button type="button" data-tab="food" aria-pressed="false">食料</button><button type="button" data-tab="treasury" aria-pressed="false">財政</button><button type="button" data-tab="research" aria-pressed="false">研究</button><button type="button" data-tab="factions" aria-pressed="false">陣営</button><button type="button" data-tab="history" aria-pressed="false">世界の履歴</button></nav>
      <p class="society-feedback" role="status" aria-live="polite">国は自律的に行動します。政策や外交を操作する国を選んでください。</p>
      <section data-pane="diplomacy"><p class="society-map-prompt">地図で外交相手を選んでください。</p>
        <div data-view="relation"></div><div data-view="truce-extension"></div>
        <div class="society-actions"><button type="button" data-action="improve" title="10 influence. Opinion +10, trust +3, tension -8.">使節を派遣 · 10</button><button type="button" data-action="pact" title="Requires opinion 20, trust 30 and influence 12.">不可侵条約 · 12</button><button type="button" data-action="trade-pact" title="Requires opinion 10, trust 30 and influence 8.">通商条約 · 8</button><button type="button" data-action="alliance" title="Requires opinion 55, trust 55 and influence 20.">防衛同盟 · 20</button></div>
        <label>援助する装備<select data-control="aid-family" aria-label="援助する装備">${familyOptions}</select></label><div class="society-actions"><button type="button" data-action="aid" title="Send equipment for the selected weapon family and retain a reserve of 30. Requires friendly relations and an open route.">武器を20送る</button><button type="button" data-action="peace" title="Propose status-quo terms. Acceptance depends on war outlook, personality and domestic stability.">白紙講和を提案</button><button type="button" data-action="crisis" class="society-danger" title="12 influence. Treaties, strategic access and military strength constrain ultimatums.">最後通牒 · 12</button></div>
        <div data-view="crisis"></div><div data-peace-ui></div><div data-peace-conference-ui></div>
        <details><summary>条約を破棄（信頼と関係が悪化）</summary><div class="society-actions"><button type="button" data-action="break-alliance">同盟を破棄</button><button type="button" data-action="break-pact">不可侵条約を破棄</button><button type="button" data-action="break-trade">通商条約を破棄</button></div></details>
        <div data-military-cooperation-ui></div>
        <h2>資源交換</h2><p class="society-note">等価の資源を交換します。輸出分は出荷時に確保され、輸送を経て届きます。</p>
        <div class="society-trade-form"><label>輸出<select data-control="export" aria-label="輸出する資源">${resourceOptions}</select></label><label>数量<input data-control="amount" aria-label="輸出する数量" type="number" min="1" max="50" value="12" step="1"></label><label>輸入<select data-control="import" aria-label="輸入する資源">${resourceOptions}</select></label><button type="button" data-action="exchange">交換を提案</button></div><p class="society-note" data-view="exchange"></p><p class="society-note" data-view="materials"></p>
        <div data-view="shipments"></div><h2>Relations</h2><div data-view="relations"></div>
      </section>
      <section data-pane="politics" hidden><div data-politics-ui></div></section>
      <section data-pane="territory" hidden><div data-territory-ui></div></section>
      <section data-pane="military" hidden><div data-mobilization-ui></div></section>
      <section data-pane="food" hidden><div data-food-ui></div></section>
      <section data-pane="treasury" hidden><div data-treasury-ui></div></section>
      <section data-pane="research" hidden>
        <p class="society-note">研究予算は全装備で共通です。装備の優先度と、強化したい性能を選んでください。研究を一時停止しても進捗は残ります。</p>
        <div class="research-programs" data-view="research-programs" aria-label="装備別の研究計画"></div>
        <div class="society-selectors"><label>装備計画<select data-control="research-family" aria-label="研究する装備">${familyOptions}</select></label>
        <label>優先度<select data-control="research-priority" aria-label="研究優先度"><option value="auto">自動</option><option value="paused">停止</option><option value="low">低</option><option value="normal">通常</option><option value="high">高</option></select></label></div>
        <div class="society-selectors"><label>重点分野<select data-control="focus" aria-label="重点分野"><option value="auto">自動</option>${branchOptions}</select></label><label>研究予算<select data-control="investment" aria-label="研究予算"><option value="economy">節約（0.5倍）</option><option value="balanced">標準（1倍）</option><option value="ambitious">重点投資（1.5倍）</option></select></label></div>
        <p class="society-note" data-view="research-status"></p><p class="society-note" data-view="prototype-materials"></p><div data-view="research"></div>
        <p class="society-note" data-view="program-description"></p><h2 data-view="design-title">最新の国産設計</h2><div class="society-design" data-view="design"></div><p class="society-note">火力、防御、速度、積載量を向上させると、費用、燃費、重量、信頼性に影響します。効率化の研究で負担を補えます。新編部隊には最新設計が適用され、既存部隊は補給の届く施設で徐々に装備を更新します。</p>
        <div class="society-actions"><button type="button" data-action="refit">この装備の部隊を最大2部隊更新</button></div>
        <h2>技術供与</h2><div class="society-trade-form"><label>供与する技術<select data-control="license" aria-label="供与技術">${branchOptions}</select></label><button type="button" data-action="license">相手国に技術を供与</button></div><p class="society-note">選択した装備計画の技術を供与します。同盟または通商条約、信頼55以上、技術の優位が必要です。自国は影響力5、相手国は武器4と鋼材2を支払い、相手国の研究が進みます。</p>
      </section>
      <section data-pane="factions" hidden><div data-faction-ui></div></section>
      <section data-pane="history" hidden>
        <div class="society-selectors"><label>出来事の分類<select data-control="event-category">
          <option value="">すべての分類</option><option value="military">軍事</option>
          <option value="diplomacy">外交</option><option value="politics">政治</option>
          <option value="trade">Trade</option><option value="aid">Aid</option><option value="research">研究</option>
        </select></label><label>対象国<select data-control="event-nations">
          <option value="">すべての国</option><option value="selected">選択中の国</option>
        </select></label></div>
        <div class="society-events" data-view="events"></div><p class="society-note">最新200件を記録し、条件に合う新しい40件を表示します。</p></section>
    </section>`;
  root.appendChild(wrapper);
  const n = (id: NationId) => esc(getNationName(world, id));
  const panel = wrapper.querySelector<HTMLElement>("#society-panel")!;
  const view = (name: string) => wrapper.querySelector<HTMLElement>(`[data-view="${name}"]`)!;
  const control = (name: string) => wrapper.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-control="${name}"]`)!;
  const nationSelect = control("nation") as HTMLSelectElement, partnerSelect = control("partner") as HTMLSelectElement;
  const getActor = () => getPlayerNation(world)?.nationId ?? nationSelect.value as NationId;
  (control("import") as HTMLSelectElement).value = "weapons";
  const feedback = wrapper.querySelector<HTMLElement>(".society-feedback")!;
  const exileControls = attachExileControls(wrapper.querySelector<HTMLElement>("[data-exile-ui]")!, world, getActor, (id) => { selectMapNation(world, id); nationSelect.value = id; update(true); });
  const politics = attachPoliticsControls(wrapper.querySelector<HTMLElement>("[data-politics-ui]")!, world,
    getActor, () => partnerSelect.value as NationId,
    (message) => { feedback.textContent = message; update(true); });
  const food = attachFoodControls(wrapper.querySelector<HTMLElement>("[data-food-ui]")!, world,
    getActor, () => partnerSelect.value as NationId, (message) => { feedback.textContent = message; });
  const treasury = attachTreasuryControls(wrapper.querySelector<HTMLElement>("[data-treasury-ui]")!, world,
    getActor, () => partnerSelect.value as NationId, (message) => { feedback.textContent = message; });
  const conference = attachPeaceConferenceControls(wrapper.querySelector<HTMLElement>("[data-peace-conference-ui]")!, world,
    getActor, () => partnerSelect.value as NationId, (message) => { feedback.textContent = message; });
  const peaceControls = attachPeaceControls(wrapper.querySelector<HTMLElement>("[data-peace-ui]")!, world, getActor, () => partnerSelect.value as NationId, (message) => { feedback.textContent = message; update(true); });
  const factions = attachFactionControls(wrapper.querySelector<HTMLElement>("[data-faction-ui]")!, world, getActor, (message) => { feedback.textContent = message; update(true); });
  const territories = attachTerritoryControls(wrapper.querySelector<HTMLElement>("[data-territory-ui]")!, world, getActor, () => partnerSelect.value as NationId, (message) => { feedback.textContent = message; update(true); });
  const mobilizationControls = attachMobilizationControls(wrapper.querySelector<HTMLElement>("[data-mobilization-ui]")!, world, getActor, (message) => { feedback.textContent = message; update(true); });
  const militaryCooperation = attachMilitaryCooperationControls(wrapper.querySelector<HTMLElement>("[data-military-cooperation-ui]")!, world, getActor, () => partnerSelect.value as NationId, (message) => { feedback.textContent = message; update(true); });
  let visible = false, lastRender = -Infinity, cachedNationIds = "";
  let researchOptionFamily = "";
  let lastPaused: boolean | undefined;
  let lastSelected: NationId | null = null, lastTarget: NationId | null = null;
  let embeddedHost: HTMLElement | null = null;
  const setVisible = (next: boolean) => {
    if (embeddedHost) return;
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
      pause.innerHTML = `${clock.paused ? "再開" : "一時停止"} <kbd>P</kbd>`;
      pause.setAttribute("aria-label", clock.paused ? "再開" : "一時停止");
    }
    if ((!visible && !embeddedHost) || (!force && performance.now() - lastRender < 750)) return;
    lastRender = performance.now();
    const active = world.nations.filter((nation) => isNationPresent(world, nation)), ids = active.map((nation) => `${n(nation.id)}:${nation.id}:${world.exileGovernments?.byNationId.get(nation.id)?.status ?? "home"}`).join("|");
    if (ids !== cachedNationIds) {
      const a = nationSelect.value, b = partnerSelect.value;
      const options = active.map((nation) => `<option value="${esc(nation.id)}">${n(nation.id)}${world.exileGovernments?.byNationId.get(nation.id)?.status === "exiled" ? "（亡命中）" : ""}</option>`).join("");
      nationSelect.innerHTML = options; partnerSelect.innerHTML = options;
      nationSelect.value = active.some((nation) => nation.id === a) ? a : active[0]?.id ?? "";
      partnerSelect.value = active.some((nation) => nation.id === b && nation.id !== nationSelect.value) ? b : active.find((nation) => nation.id !== nationSelect.value)?.id ?? "";
      cachedNationIds = ids;
    }
    const map = getMapView(world);
    const playerId = getPlayerNation(world)?.nationId;
    const actor = playerId ?? (map.mode === "diplomacy" ? map.diplomaticFocusId : map.selectedNationId);
    nationSelect.disabled = !!playerId;
    if (playerId) nationSelect.value = playerId;
    if (actor !== lastSelected && active.some((nation) => nation.id === actor)) {
      nationSelect.value = actor!; lastSelected = actor;
    }
    if (embeddedHost) {
      partnerSelect.value = map.targetNationId ?? "";
    } else if (map.targetNationId !== lastTarget && active.some((nation) => nation.id === map.targetNationId)) {
      partnerSelect.value = map.targetNationId!; lastTarget = map.targetNationId;
    }
    if (!embeddedHost && nationSelect.value === partnerSelect.value) partnerSelect.value = active.find((nation) => nation.id !== nationSelect.value)?.id ?? "";
    if (!partnerSelect.value) partnerSelect.value = nationSelect.value;
    const a = getActor(), b = partnerSelect.value as NationId;
    const nation = active.find((item) => item.id === a);
    if (!nation) { setText("country", "活動中の国はありません。"); return; }
    const settings = world.settings ?? createSimulationSettings({ diplomacyEnabled: false });
    for (const input of wrapper.querySelectorAll<HTMLInputElement>("[data-setting]")) {
      input.checked = settings[input.dataset.setting as keyof typeof settings];
      input.disabled = input.dataset.setting === "legacyWarDeclarationsEnabled" && settings.diplomacyEnabled;
    }
    const mode = getWarDeclarationMode(world);
    setText("mode", `宣戦方式： ${mode === "diplomacy" ? "外交システム（旧方式の自動宣戦は無効）" : mode === "legacy" ? "旧方式の自動宣戦" : "自動宣戦なし"}`);
    const character = getNationCharacter(world, a), relation = world.diplomacy?.relations.get(relationKey(a, b));
    view("country").innerHTML = `<strong>${n(a)}</strong><span>${DOCTRINES[character.doctrine]} · ${esc(getNationIdeology(world, a).name)} · 影響力 ${Math.floor(world.diplomacy?.influenceByNationId.get(a) ?? 30)}</span><small>鋼材 ${Math.floor(nation.resources.steel)} / 燃料 ${Math.floor(nation.resources.fuel)} / 武器 ${Math.floor(nation.resources.weapons)}</small>`;
    const treaties = relation?.treaties.filter((treaty) => treaty.expiresAtSlowTick > world.time.slowTick) ?? [];
    const outrage = Math.round(getPublicOutrage(world, a, b));
    const partnerOutrage = Math.round(getPublicOutrage(world, b, a));
    const diplomacyPane = wrapper.querySelector<HTMLElement>('[data-pane="diplomacy"]')!;
    diplomacyPane.classList.toggle("society-no-partner", !!embeddedHost && a === b);
    view("relation").innerHTML = `<h2>${n(b)}との関係</h2><p class="society-note">思想： ${esc(getNationIdeology(world, a).name)} ↔ ${esc(getNationIdeology(world, b).name)} · ${ideologyAffinityLabel(getIdeologicalAffinity(world, a, b))}</p>${findWar(world.wars, a, b) ? '<p class="society-note">交戦中</p>' : ""}${relation ? `<div class="society-metrics"><span>関係 <b>${Math.round(relation.opinion)}</b></span><span>信頼 <b>${Math.round(relation.trust)}</b></span><span>緊張 <b>${Math.round(relation.tension)}</b></span></div><p class="society-note">${treaties.map((treaty) => `${TREATY_NAMES[treaty.type]} (${treaty.expiresAtSlowTick - world.time.slowTick}秒)`).join(" / ") || "条約なし"}</p>` : '<p class="society-note">外交関係の記録はまだありません。</p>'}`;
    if (outrage || partnerOutrage) view("relation").insertAdjacentHTML("beforeend",
      `<p class="society-note">迫害に対する世論の反発 · ${n(a)} ${outrage}/100 · ${n(b)} ${partnerOutrage}/100</p>`);
    if (treaties.some((treaty) => treaty.type === "truce")) {
      const issue = getTruceExtensionIssue(world, a, b);
      view("truce-extension").innerHTML = `<div class="society-actions"><button type="button" data-action="extend-truce" ${issue ? "disabled" : ""}>休戦を延長：${TRUCE_EXTENSION.seconds}s · ${TRUCE_EXTENSION.cost}</button></div>${issue ? `<p class="society-note">${esc(issue)}</p>` : ""}`;
    } else view("truce-extension").replaceChildren();
    const crisis = relation?.crisis;
    const staged = crisis ? getCrisisDeploymentReadiness(world, crisis.aggressorId, crisis.aggressorId === a ? b : a) : undefined;
    const deployment = staged === undefined ? "" : `<br>国境部隊の集結率： ${Math.round(staged * 100)}%`;
    view("crisis").innerHTML = crisis ? `<div class="society-crisis">最後通牒： ${n(crisis.aggressorId)} → ${n(crisis.aggressorId === a ? b : a)}${crisis.demand === "territory" ? `<br>要求：${(crisis.regionIds ?? []).map(districtName).join(", ")}` : ""}<br>交渉期限： ${Math.max(0, crisis.deadlineSlowTick - world.time.slowTick)}s${deployment}${crisis.aggressorId !== a ? `<div class="society-actions"><button type="button" data-action="negotiate">交渉する · 15</button><button type="button" data-action="concede">${crisis.demand === "territory" ? "領土要求を受け入れる" : "武器30を譲渡"}</button><button type="button" data-action="reject">拒否</button></div>` : ""}</div>` : "";
    const offered = control("export").value as TradeResource, requested = control("import").value as TradeResource;
    const amount = Number(control("amount").value);
    setText("materials", STRATEGIC_RESOURCES.filter((resource) => nation?.resources[resource] !== undefined)
      .map((resource) => `${RESOURCE_NAMES[resource]}: ${Math.floor(nation!.resources[resource] ?? 0)}`).join(" · "));
    setText("exchange", `${Number.isFinite(amount) ? amount : 0} ${RESOURCE_NAMES[offered]} ↔ ${(Number.isFinite(amount) ? amount * TRADE_RESOURCE_VALUES[offered] / TRADE_RESOURCE_VALUES[requested] : 0).toFixed(1)} ${RESOURCE_NAMES[requested]}. 協定、通行可能な経路、余剰資源が必要です。`);
    const trades = (world.internationalTrade?.deals ?? []).filter((deal) => deal.sellerId === a || deal.buyerId === a).slice(-4);
    const aid = (world.armsAid?.shipments ?? []).filter((shipment) => shipment.donorId === a || shipment.recipientId === a).slice(-3);
    const statusName = { "in-transit": "輸送中", delivered: "到着済み", returned: "返送済み" };
    view("shipments").innerHTML = `<h2>取引・援助の輸送</h2>${trades.map((deal) => `<p class="society-note">${n(deal.sellerId)} ↔ ${n(deal.buyerId)}：${RESOURCE_NAMES[deal.offeredResource]} ${deal.offeredAmount.toFixed(1)} / ${deal.humanitarian ? "穀物援助" : `${RESOURCE_NAMES[deal.requestedResource]} ${deal.requestedAmount.toFixed(1)}`} · ${statusName[deal.status]}${deal.status === "in-transit" ? ` (${Math.max(0, deal.arrivesAtSlowTick - world.time.slowTick)}秒)` : ""}</p>`).join("")}${aid.map((shipment) => `<p class="society-note">${n(shipment.donorId)} → ${n(shipment.recipientId)}：武器 ${shipment.weapons} · ${statusName[shipment.status]}</p>`).join("")}${trades.length + aid.length === 0 ? '<p class="society-note">輸送の記録はまだありません。</p>' : ""}`;
    view("relations").innerHTML = `<table><thead><tr><th>相手国</th><th>関係</th><th>条約</th></tr></thead><tbody>${active.filter((item) => item.id !== a).map((other) => {
      const item = world.diplomacy?.relations.get(relationKey(a, other.id));
      return `<tr><td><button type="button" data-action="partner" data-partner="${esc(other.id)}">${n(other.id)}</button></td><td>${item ? Math.round(item.opinion) : "接触なし"}</td><td>${item?.treaties.filter((treaty) => treaty.expiresAtSlowTick > world.time.slowTick).map((treaty) => TREATY_NAMES[treaty.type]).join(" / ") || "—"}</td></tr>`;
    }).join("")}</tbody></table>`;
    const family = control("research-family").value as EquipmentFamily;
    const portfolio = getResearchPortfolio(world, a, family), national = getResearchPortfolio(world, a);
    const prototypeMaterials = nation ? getPrototypeMaterialRates(nation.resources, family) : [];
    setText("prototype-materials", ["研究力1あたり：鋼材0.4、武器0.2",
      ...prototypeMaterials.map(([resource, rate]) => `${rate} ${RESOURCE_NAMES[resource]} (${(nation?.resources[resource] ?? 0).toFixed(1)} 在庫）`)].join(" · "));
    if (researchOptionFamily !== family) {
      const options = FAMILY_RESEARCH_BRANCHES[family].map((branch) => `<option value="${branch}">${BRANCH_NAMES[branch]}</option>`).join("");
      control("focus").innerHTML = `<option value="auto">自動</option>${options}`;
      control("license").innerHTML = options; researchOptionFamily = family;
    }
    if (document.activeElement !== control("focus")) control("focus").value = portfolio.focus;
    if (document.activeElement !== control("investment")) control("investment").value = national.investment;
    if (document.activeElement !== control("research-priority")) control("research-priority").value = portfolio.priority ?? "auto";
    const summary = getNationalResearchSummary(world, a), weights = getEquipmentResearchPriorities(world, a);
    const totalWeight = Object.values(weights).reduce((sum, value) => sum + value, 0);
    view("research-programs").innerHTML = EQUIPMENT_FAMILIES.map((type) => {
      const program = getResearchPortfolio(world, a, type), share = totalWeight ? (weights[type] / totalWeight * 100).toFixed(1) : "0.0";
      return `<button type="button" data-research-family="${type}" aria-pressed="${type === family}"><strong>${EQUIPMENT_FAMILY_NAMES[type]}</strong><span>${({ auto: "自動", paused: "停止", low: "低", normal: "通常", high: "高" })[program.priority ?? "auto"]} · ${share}% 配分</span><small>${program.completedProjects}件 · 直近 ${program.lastScience.toFixed(2)}/s</small></button>`;
    }).join("");
    setText("research-status", `${settings.researchEnabled ? RESEARCH_STATUS[portfolio.status] : "研究停止中"} · ${EQUIPMENT_FAMILY_NAMES[family]} 重点：${BRANCH_NAMES[portfolio.focus === "auto" ? portfolio.primaryBranch : portfolio.focus]} · 直近の研究力： 装備別 ${portfolio.lastScience.toFixed(2)}/s／全国 ${summary.lastScience.toFixed(2)}/s · 完了 ${summary.completedProjects}件`);
    view("research").innerHTML = FAMILY_RESEARCH_BRANCHES[family].map((branch) => {
      const cost = getResearchCost(portfolio, branch), percent = portfolio.levels[branch] >= 10 ? 100 : Math.min(100, portfolio.progress[branch] / cost * 100);
      return `<div class="society-research-row"><span>${BRANCH_NAMES[branch]}</span><b>Lv.${portfolio.levels[branch]}</b><progress aria-label="${BRANCH_NAMES[branch]}の研究進捗" max="100" value="${percent}"></progress><small>${Math.floor(percent)}%</small></div>`;
    }).join("");
    setText("program-description", {
      Infantry: "小火器は火力、精度・取り回し、信頼性を強化できます。取り回しが良いと実効火力と組織率の回復が上がります。精密な武器は製造費がかかります。",
      Tank: "戦車は火力、防御、速度を強化できます。装甲は損害を減らす一方、重量と燃料消費を増やします。高速なエンジンは燃料を多く使い、信頼性の向上も必要です。",
      CombatShip: "戦闘艦は砲火力、防御、速度を強化できます。装甲は速度を落とし、強力な砲や機関は運用費を増やします。効率や信頼性の研究で負担を軽減できます。",
      TransportShip: "輸送船は積載量、防御、速度を強化できます。積載量の伸びは徐々に小さくなり、標準10部隊の船はレベル10で最大25部隊を運べます。大型船は費用と燃料消費が増え、速度が下がります。",
    }[family]);
    if (!panel.querySelector<HTMLElement>('[data-pane="politics"]')?.hidden) politics.update(nation);
    if (!panel.querySelector<HTMLElement>('[data-pane="food"]')?.hidden) food.update(nation);
    if (!panel.querySelector<HTMLElement>('[data-pane="treasury"]')?.hidden) treasury.update(nation);
    peaceControls.update();
    conference.update();
    exileControls.update();
    factions.update();
    territories.update();
    mobilizationControls.update();
    militaryCooperation.update();
    const design = getNationalDesign(world, a, family);
    setText("design-title", `${EQUIPMENT_FAMILY_NAMES[family]} · 国産設計の世代 ${design.generation}`);
    const stats: [string, string][] = [["信頼性", `×${design.reliability.toFixed(2)}`], ["必要な武器", `×${design.weaponCost.toFixed(2)}`], ["組織率の回復", `×${design.recovery.toFixed(2)}`]];
    if (family !== "TransportShip") stats.unshift(["火力", `×${design.firepower.toFixed(2)}`]);
    if (family === "Infantry") stats.push(["精度・取り回し", `×${(design.handling ?? 1).toFixed(2)}`]);
    else stats.push(["防御", `×${(design.armor ?? 1).toFixed(2)}`], ["速度", `×${(design.mobility ?? 1).toFixed(2)}`], ["燃料消費", `×${design.fuelUse.toFixed(2)}`]);
    if (family === "TransportShip") stats.push(["輸送容量", `${getDesignTransportCapacity(design)} units`]);
    view("design").innerHTML = stats.map(([label, value]) => `<span>${label}<strong>${value}</strong></span>`).join("");
    const category = control("event-category").value;
    const selectedOnly = control("event-nations").value === "selected";
    const events = (world.events ?? []).filter((event) =>
      (!category || event.category === category) && (!selectedOnly || event.nationIds.includes(a)));
    view("events").innerHTML = events.slice(-40).reverse().map((event) => `<article class="society-event"><time>${Math.floor(event.tick / 600)}:${String(Math.floor(event.tick / 10) % 60).padStart(2, "0")}</time><span>${esc(event.message)}</span></article>`).join("") || '<p class="society-note">条件に合う出来事はありません。</p>';
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
      feedback.textContent = "設定を更新しました。進行中の戦争は継続し、輸送は次の更新時に再確認されます。";
    } else if (["focus", "investment", "research-priority"].includes(target.dataset.control ?? "")) {
      const portfolio = getResearchPortfolio(world, getActor(), control("research-family").value as EquipmentFamily);
      if (target.dataset.control === "focus") portfolio.focus = target.value as ResearchPortfolio["focus"];
      else if (target.dataset.control === "research-priority") portfolio.priority = target.value as ResearchPriority;
      else getResearchPortfolio(world, getActor()).investment = target.value as ResearchPortfolio["investment"];
      feedback.textContent = "研究方針を変更しました。次の更新から適用されます。";
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
    if (action === "partner") {
      const partner = button.dataset.partner as NationId;
      if (embeddedHost) selectMapNation(world, partner);
      else partnerSelect.value = partner;
      update(true); return;
    }
    const a = getActor(), b = partnerSelect.value as NationId;
    let success = false;
    if (action === "improve") success = improveRelations(world, a, b);
    else if (action === "pact") success = proposeTreaty(world, a, b, "non-aggression");
    else if (action === "trade-pact") success = proposeTreaty(world, a, b, "trade");
    else if (action === "alliance") success = proposeTreaty(world, a, b, "alliance");
    else if (action === "aid") success = sendArmsAid(world, a, b, 20, control("aid-family").value as EquipmentFamily);
    else if (action === "peace") success = offerPeace(world, a, b);
    else if (action === "extend-truce") success = extendTruce(world, a, b);
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
    if (action === "peace" && success) { feedback.textContent = findWar(world.wars, a, b) ? "白紙講和を提案しました。相手国は戦況に応じて判断します。" : "講和が成立し、休戦と部隊の撤収が始まりました。"; update(true); return; }
    feedback.textContent = success ? "操作を完了しました。関係、資源、輸送、履歴を更新しました。" :
      "条件を満たしていません。影響力、関係、協定、備蓄、経路を確認してください。装備の更新には改良設計と補給の届く施設が必要です。";
    update(true);
  });
  window.addEventListener("keydown", (event) => {
    if (event.code === "Escape" && visible && !embeddedHost) { setVisible(false); return; }
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
  const tabNames: Record<string, string> = {
    diplomacy: "外交・講和", politics: "政治", territory: "領土", military: "軍備",
    food: "食料", treasury: "財政", research: "研究", factions: "陣営", history: "履歴",
  };
  const tabButtons = [...wrapper.querySelectorAll<HTMLButtonElement>("[data-tab]")];
  const originalTabNames = tabButtons.map((button) => button.textContent);
  const setEmbedded = (host: HTMLElement | null) => {
    if (embeddedHost === host) return;
    embeddedHost = host;
    tabButtons.forEach((button, index) => {
      button.textContent = host ? tabNames[button.dataset.tab!] : originalTabNames[index];
    });
    panel.classList.toggle("society-embedded", !!host);
    wrapper.classList.toggle("society-docked", !!host);
    (host ?? root).append(wrapper);
    visible = false;
    panel.hidden = !host;
    if (host) {
      feedback.textContent = "";
      openPane("research");
    } else {
      territories.clearPreview();
      wrapper.querySelector("[data-action=toggle]")!.setAttribute("aria-expanded", "false");
    }
  };
  const openNegotiations = () => {
    openPane("diplomacy");
    const negotiation = panel.querySelector<HTMLDetailsElement>("[data-peace-panel]");
    if (negotiation) {
      negotiation.open = true;
      negotiation.scrollIntoView({ block: "start" });
    }
  };
  return { update: () => update(), openNegotiations, openDiplomacy: () => openPane("diplomacy"), openFactions: () => openPane("factions"), setEmbedded, close: () => setVisible(false) };
}
