import type { NationId } from "../worldgen/nation";
import { getNationCharacter } from "../sim/nation-character";
import { breakTreaty, improveRelations, proposeTreaty, relationKey } from "../sim/diplomacy";
import { openDiplomaticCrisis, respondToCrisis } from "../sim/diplomatic-crises";
import { offerPeace } from "../sim/diplomatic-peace";
import { sendArmsAid } from "../sim/arms-aid";
import { refitUnit } from "../sim/equipment-development";
import { proposeResourceTrade, TRADE_RESOURCE_VALUES, type TradeResource } from "../sim/international-trade";
import { getNationalDesign, getResearchCost, getResearchPortfolio, emptyResearchLevels,
  RESEARCH_BRANCHES, type ResearchBranch, type ResearchPortfolio } from "../sim/research";
import { createSimulationSettings, getWarDeclarationMode } from "../sim/simulation-settings";
import { licenseTechnology } from "../sim/technology-exchange";
import { isNationActive } from "../sim/nation-active";
import type { SimClock } from "../sim/time";
import type { WorldState } from "../sim/world-state";

const BRANCH_NAMES: Record<ResearchBranch, string> = {
  firepower: "威力", reliability: "安定性", materials: "素材節約", fuel: "燃費", logistics: "兵站", production: "生産技術",
};
const DOCTRINES = { expansionist: "拡張主義", merchant: "商業重視", technocrat: "技術重視",
  guardian: "防衛重視", pragmatist: "現実主義", isolationist: "孤立主義" };
const TREATY_NAMES = { alliance: "防衛同盟", trade: "交易協定", "non-aggression": "不可侵", truce: "休戦" };
const RESOURCE_NAMES: Record<TradeResource, string> = { steel: "鉄鋼", fuel: "燃料", weapons: "武器" };
const RESEARCH_STATUS = { researching: "研究中", "saving resources": "研究費を確保中", "capital isolated": "首都の補給途絶", complete: "全研究完了", paused: "準備中" };
const esc = (value: unknown) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));

export function attachSocietyPanel(root: HTMLElement, world: WorldState, clock: SimClock): { update: () => void } {
  const wrapper = document.createElement("div"); wrapper.className = "society-ui";
  const branchOptions = RESEARCH_BRANCHES.map((branch) => `<option value="${branch}">${BRANCH_NAMES[branch]}</option>`).join("");
  const resourceOptions = Object.entries(RESOURCE_NAMES).map(([value, label]) => `<option value="${value}">${label}</option>`).join("");
  wrapper.innerHTML = `
    <div class="society-launch"><button type="button" data-action="toggle" aria-expanded="false" aria-controls="society-panel">外交・研究 <kbd>I</kbd></button><button type="button" data-action="pause" aria-label="一時停止">一時停止 <kbd>P</kbd></button></div>
    <section id="society-panel" class="society-panel" aria-label="外交と研究" hidden>
      <header><div><span class="society-eyebrow">NATIONS & IDEAS</span><h1>外交・研究</h1></div><button type="button" data-action="close" aria-label="外交と研究を閉じる">閉じる ×</button></header>
      <details class="society-settings"><summary>シミュレーション設定</summary>
        <label><input type="checkbox" data-setting="diplomacyEnabled"> 外交（ONの間は従来の自動開戦を停止）</label>
        <label><input type="checkbox" data-setting="legacyWarDeclarationsEnabled"> 従来の自動開戦（外交OFF時）</label>
        <label><input type="checkbox" data-setting="researchEnabled"> 国家研究・自動改修</label>
        <label><input type="checkbox" data-setting="armsAidEnabled"> 武器供与</label>
        <label><input type="checkbox" data-setting="tradeEnabled"> 資源交易</label>
        <p data-view="mode"></p>
      </details>
      <div class="society-selectors"><label>観察・方針変更する国<select data-control="nation" aria-label="観察する国"></select></label><label>外交相手<select data-control="partner" aria-label="外交相手"></select></label></div>
      <div class="society-country" data-view="country"></div>
      <nav class="society-tabs" aria-label="情報の種類"><button type="button" data-tab="diplomacy" aria-pressed="true">外交・交易</button><button type="button" data-tab="research" aria-pressed="false">研究・兵器</button><button type="button" data-tab="history" aria-pressed="false">世界の年表</button></nav>
      <p class="society-feedback" role="status" aria-live="polite">各国は自動で判断します。ここでは国を選び、方針や外交に介入できます。</p>
      <section data-pane="diplomacy">
        <div data-view="relation"></div>
        <div class="society-actions"><button type="button" data-action="improve" title="外交力10。友好度+10、信頼+3、緊張-8">使節を送る · 10</button><button type="button" data-action="pact" title="友好20・信頼30・外交力12が必要">不可侵を提案 · 12</button><button type="button" data-action="trade-pact" title="友好10・信頼30・外交力8が必要">交易協定 · 8</button><button type="button" data-action="alliance" title="友好55・信頼55・外交力20が必要">防衛同盟 · 20</button></div>
        <div class="society-actions"><button type="button" data-action="aid" title="武器20を送り、武器30を自国に残します。友好関係と輸送経路が必要です">武器20を供与</button><button type="button" data-action="peace" title="短すぎる戦争や、一方が勝利目前の場合は拒否されます">講和を打診</button><button type="button" data-action="crisis" class="society-danger" title="外交力12。条約・軍事的到達性・自軍の戦力を確認して最後通牒を送ります">最後通牒 · 12</button></div>
        <div data-view="crisis"></div>
        <details><summary>条約の破棄（信頼・友好が低下）</summary><div class="society-actions"><button type="button" data-action="break-alliance">同盟を破棄</button><button type="button" data-action="break-pact">不可侵を破棄</button><button type="button" data-action="break-trade">交易協定を破棄</button></div></details>
        <h2>資源の交換</h2><p class="society-note">双方が同等の価値を交換。輸出分は先に確保され、輸送後に届きます。</p>
        <div class="society-trade-form"><label>輸出<select data-control="export" aria-label="輸出する資源">${resourceOptions}</select></label><label>数量<input data-control="amount" aria-label="輸出数量" type="number" min="1" max="50" value="12" step="1"></label><label>受取<select data-control="import" aria-label="受け取る資源">${resourceOptions}</select></label><button type="button" data-action="exchange">交換を提案</button></div><p class="society-note" data-view="exchange"></p>
        <div data-view="shipments"></div><h2>関係一覧</h2><div data-view="relations"></div>
      </section>
      <section data-pane="research" hidden>
        <div class="society-selectors"><label>研究重点<select data-control="focus" aria-label="研究重点"><option value="auto">国家性格と情勢で自動</option>${branchOptions}</select></label><label>研究予算<select data-control="investment" aria-label="研究予算"><option value="economy">節約（0.5倍）</option><option value="balanced">標準（1倍）</option><option value="ambitious">積極（1.5倍）</option></select></label></div>
        <p class="society-note" data-view="research-status"></p><div data-view="research"></div>
        <h2>自国の最新設計</h2><div class="society-design" data-view="design"></div><p class="society-note">威力強化は製造費・燃料を増やし、安定性を下げます。素材・燃費・安定性の研究で補えます。新造部隊に配備し、既存部隊は補給のある施設で費用を払って改修します。</p>
        <div class="society-actions"><button type="button" data-action="refit">可能な部隊を2個まで改修</button></div>
        <h2>技術許諾</h2><div class="society-trade-form"><label>相手に許諾する技術<select data-control="license" aria-label="許諾する技術">${branchOptions}</select></label><button type="button" data-action="license">選択中の外交相手に許諾</button></div><p class="society-note">同盟か交易協定、信頼55、技術差が必要。自国の外交力5と、相手の武器4・鉄鋼2を使い、相手の研究を早めます。</p>
      </section>
      <section data-pane="history" hidden><div class="society-events" data-view="events"></div><p class="society-note">直近200件を保持。ここでは新しい40件を表示します。</p></section>
    </section>`;
  root.appendChild(wrapper);
  const panel = wrapper.querySelector<HTMLElement>("#society-panel")!;
  const view = (name: string) => wrapper.querySelector<HTMLElement>(`[data-view="${name}"]`)!;
  const control = (name: string) => wrapper.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-control="${name}"]`)!;
  const nationSelect = control("nation") as HTMLSelectElement, partnerSelect = control("partner") as HTMLSelectElement;
  (control("import") as HTMLSelectElement).value = "weapons";
  const feedback = wrapper.querySelector<HTMLElement>(".society-feedback")!;
  let visible = false, lastRender = -Infinity, cachedNationIds = "";
  let lastPaused: boolean | undefined;
  const setVisible = (next: boolean) => {
    visible = next; panel.hidden = !next;
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
    if (!visible || (!force && performance.now() - lastRender < 750)) return;
    lastRender = performance.now();
    const active = world.nations.filter(isNationActive), ids = active.map((nation) => nation.id).join("|");
    if (ids !== cachedNationIds) {
      const a = nationSelect.value, b = partnerSelect.value;
      const options = active.map((nation) => `<option value="${esc(nation.id)}">${esc(nation.id)}</option>`).join("");
      nationSelect.innerHTML = options; partnerSelect.innerHTML = options;
      nationSelect.value = active.some((nation) => nation.id === a) ? a : active[0]?.id ?? "";
      partnerSelect.value = active.some((nation) => nation.id === b && nation.id !== nationSelect.value) ? b : active.find((nation) => nation.id !== nationSelect.value)?.id ?? "";
      cachedNationIds = ids;
    }
    const a = nationSelect.value as NationId, b = partnerSelect.value as NationId;
    const nation = active.find((item) => item.id === a);
    if (!nation) { setText("country", "活動中の国家がありません。"); return; }
    const settings = world.settings ?? createSimulationSettings({ diplomacyEnabled: false });
    for (const input of wrapper.querySelectorAll<HTMLInputElement>("[data-setting]")) {
      input.checked = settings[input.dataset.setting as keyof typeof settings];
      input.disabled = input.dataset.setting === "legacyWarDeclarationsEnabled" && settings.diplomacyEnabled;
    }
    const mode = getWarDeclarationMode(world);
    setText("mode", `開戦方式：${mode === "diplomacy" ? "外交交渉（従来方式は停止中）" : mode === "legacy" ? "従来の自動開戦" : "自動開戦なし"}`);
    const character = getNationCharacter(world, a), relation = world.diplomacy?.relations.get(relationKey(a, b));
    view("country").innerHTML = `<strong>${esc(a)}</strong><span>${DOCTRINES[character.doctrine]} · 外交力 ${Math.floor(world.diplomacy?.influenceByNationId.get(a) ?? 30)}</span><small>鉄鋼 ${Math.floor(nation.resources.steel)} / 燃料 ${Math.floor(nation.resources.fuel)} / 武器 ${Math.floor(nation.resources.weapons)}</small>`;
    const treaties = relation?.treaties.filter((treaty) => treaty.expiresAtSlowTick > world.time.slowTick) ?? [];
    view("relation").innerHTML = `<h2>${esc(b)} との関係</h2>${relation ? `<div class="society-metrics"><span>友好 <b>${Math.round(relation.opinion)}</b></span><span>信頼 <b>${Math.round(relation.trust)}</b></span><span>緊張 <b>${Math.round(relation.tension)}</b></span></div><p class="society-note">${treaties.map((treaty) => `${TREATY_NAMES[treaty.type]}（残り${treaty.expiresAtSlowTick - world.time.slowTick}秒）`).join(" / ") || "条約なし"}</p>` : '<p class="society-note">未接触。使節を送り、関係を築くことができます。</p>'}`;
    const crisis = relation?.crisis;
    view("crisis").innerHTML = crisis ? `<div class="society-crisis">最後通牒：${esc(crisis.aggressorId)} → ${esc(crisis.aggressorId === a ? b : a)}<br>交渉期限まで ${Math.max(0, crisis.deadlineSlowTick - world.time.slowTick)}秒${crisis.aggressorId !== a ? '<div class="society-actions"><button type="button" data-action="negotiate">交渉する · 15</button><button type="button" data-action="concede">武器30で譲歩</button><button type="button" data-action="reject">拒否する</button></div>' : ""}</div>` : "";
    const offered = control("export").value as TradeResource, requested = control("import").value as TradeResource;
    const amount = Number(control("amount").value);
    setText("exchange", `${Number.isFinite(amount) ? amount : 0} ${RESOURCE_NAMES[offered]} ↔ ${(Number.isFinite(amount) ? amount * TRADE_RESOURCE_VALUES[offered] / TRADE_RESOURCE_VALUES[requested] : 0).toFixed(1)} ${RESOURCE_NAMES[requested]}。協定・経路・余剰資源が必要です。`);
    const trades = (world.internationalTrade?.deals ?? []).filter((deal) => deal.sellerId === a || deal.buyerId === a).slice(-4);
    const aid = (world.armsAid?.shipments ?? []).filter((shipment) => shipment.donorId === a || shipment.recipientId === a).slice(-3);
    const statusName = { "in-transit": "輸送中", delivered: "到着", returned: "返送" };
    view("shipments").innerHTML = `<h2>交易・援助の輸送</h2>${trades.map((deal) => `<p class="society-note">${esc(deal.sellerId)} ↔ ${esc(deal.buyerId)}：${RESOURCE_NAMES[deal.offeredResource]} ${deal.offeredAmount.toFixed(1)} / ${RESOURCE_NAMES[deal.requestedResource]} ${deal.requestedAmount.toFixed(1)} · ${statusName[deal.status]}${deal.status === "in-transit" ? `（残り${Math.max(0, deal.arrivesAtSlowTick - world.time.slowTick)}秒）` : ""}</p>`).join("")}${aid.map((shipment) => `<p class="society-note">${esc(shipment.donorId)} → ${esc(shipment.recipientId)}：武器 ${shipment.weapons} · ${statusName[shipment.status]}</p>`).join("")}${trades.length + aid.length === 0 ? '<p class="society-note">まだ輸送はありません。</p>' : ""}`;
    view("relations").innerHTML = `<table><thead><tr><th>相手</th><th>友好</th><th>条約</th></tr></thead><tbody>${active.filter((item) => item.id !== a).map((other) => {
      const item = world.diplomacy?.relations.get(relationKey(a, other.id));
      return `<tr><td><button type="button" data-action="partner" data-partner="${esc(other.id)}">${esc(other.id)}</button></td><td>${item ? Math.round(item.opinion) : "未接触"}</td><td>${item?.treaties.filter((treaty) => treaty.expiresAtSlowTick > world.time.slowTick).map((treaty) => TREATY_NAMES[treaty.type]).join(" / ") || "—"}</td></tr>`;
    }).join("")}</tbody></table>`;
    const portfolio: ResearchPortfolio = world.research?.byNationId.get(a) ?? { levels: emptyResearchLevels(), progress: emptyResearchLevels(), focus: "auto", investment: "balanced", primaryBranch: "firepower", status: "paused", lastScience: 0, totalScience: 0, completedProjects: 0 };
    if (document.activeElement !== control("focus")) control("focus").value = portfolio.focus;
    if (document.activeElement !== control("investment")) control("investment").value = portfolio.investment;
    setText("research-status", `${settings.researchEnabled ? RESEARCH_STATUS[portfolio.status] : "研究停止中"} · 現在の重点：${BRANCH_NAMES[portfolio.primaryBranch]} · 研究力 ${portfolio.lastScience.toFixed(2)}/秒 · 完了 ${portfolio.completedProjects}件`);
    view("research").innerHTML = RESEARCH_BRANCHES.map((branch) => {
      const cost = getResearchCost(portfolio, branch), percent = portfolio.levels[branch] >= 10 ? 100 : Math.min(100, portfolio.progress[branch] / cost * 100);
      return `<div class="society-research-row"><span>${BRANCH_NAMES[branch]}</span><b>Lv.${portfolio.levels[branch]}</b><progress aria-label="${BRANCH_NAMES[branch]}の研究進捗" max="100" value="${percent}"></progress><small>${Math.floor(percent)}%</small></div>`;
    }).join("");
    const design = getNationalDesign(world, a);
    view("design").innerHTML = [["威力", design.firepower], ["安定性", design.reliability], ["必要武器", design.weaponCost], ["製造鉄鋼", design.steelCost], ["燃料消費", design.fuelUse], ["組織回復", design.recovery]].map(([label, value]) => `<span>${label}<strong>×${Number(value).toFixed(2)}</strong></span>`).join("");
    view("events").innerHTML = [...(world.events ?? [])].slice(-40).reverse().map((event) => `<article class="society-event"><time>${Math.floor(event.tick / 600)}:${String(Math.floor(event.tick / 10) % 60).padStart(2, "0")}</time><span>${esc(event.message)}</span></article>`).join("") || '<p class="society-note">交渉・交易・研究の出来事がここに記録されます。</p>';
    for (const button of panel.querySelectorAll<HTMLButtonElement>("button[data-action]")) {
      const action = button.dataset.action;
      if (["improve", "pact", "trade-pact", "alliance", "aid", "peace", "crisis", "negotiate", "concede", "reject", "break-alliance", "break-pact", "break-trade", "exchange", "license"].includes(action ?? "")) {
        button.disabled = mode !== "diplomacy" || a === b || !active.some((item) => item.id === b) ||
          (action === "aid" && !settings.armsAidEnabled) || (action === "exchange" && !settings.tradeEnabled) ||
          (action === "license" && !settings.researchEnabled);
      }
      if (action === "refit") button.disabled = !settings.researchEnabled;
    }
  };

  wrapper.addEventListener("change", (event) => {
    const target = event.target as HTMLInputElement;
    if (target.dataset.setting) {
      world.settings ??= createSimulationSettings();
      world.settings[target.dataset.setting as keyof typeof world.settings] = target.checked;
      feedback.textContent = "設定を変更しました。既存の戦争は続き、輸送中の契約は次の評価で確認されます。";
    } else if (target.dataset.control === "focus" || target.dataset.control === "investment") {
      const portfolio = getResearchPortfolio(world, nationSelect.value as NationId);
      if (target.dataset.control === "focus") portfolio.focus = target.value as ResearchPortfolio["focus"];
      else portfolio.investment = target.value as ResearchPortfolio["investment"];
      feedback.textContent = "研究方針を変更しました。次の評価から反映し、これまでの研究進捗は保持します。";
    } else if (target.dataset.control === "nation" && nationSelect.value === partnerSelect.value) {
      partnerSelect.value = world.nations.find((nation) => isNationActive(nation) && nation.id !== nationSelect.value)?.id ?? "";
    }
    update(true);
  });
  wrapper.addEventListener("input", (event) => { if ((event.target as HTMLElement).dataset.control === "amount") update(true); });
  wrapper.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button");
    if (!button) return;
    if (button.dataset.tab) {
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
    else if (action === "aid") success = sendArmsAid(world, a, b);
    else if (action === "peace") success = offerPeace(world, a, b);
    else if (action === "crisis") success = openDiplomaticCrisis(world, a, b);
    else if (action === "negotiate" || action === "concede" || action === "reject") success = respondToCrisis(world, a, b, action);
    else if (action === "break-alliance") success = breakTreaty(world, a, b, "alliance");
    else if (action === "break-pact") success = breakTreaty(world, a, b, "non-aggression");
    else if (action === "break-trade") success = breakTreaty(world, a, b, "trade");
    else if (action === "exchange") {
      const offered = control("export").value as TradeResource, requested = control("import").value as TradeResource, amount = Number(control("amount").value);
      success = proposeResourceTrade(world, a, b, offered, amount, requested, amount * TRADE_RESOURCE_VALUES[offered] / TRADE_RESOURCE_VALUES[requested]);
    } else if (action === "license") success = licenseTechnology(world, a, b, control("license").value as ResearchBranch);
    else if (action === "refit") {
      let count = 0;
      for (const unit of world.units.filter((item) => item.nationId === a)) if (count < 2 && refitUnit(world, unit.id)) count += 1;
      success = count > 0;
    }
    feedback.textContent = success ? "実行しました。関係値・備蓄・輸送・年表へ反映されます。" :
      "条件が整っていません。外交力、友好・信頼、条約、備蓄と経路を確認してください。研究・改修には技術差と費用、補給のある施設が必要です。";
    update(true);
  });
  window.addEventListener("keydown", (event) => {
    if (event.code === "Escape" && visible) { setVisible(false); return; }
    if (event.repeat || (event.target instanceof HTMLElement && (event.target.isContentEditable || event.target.closest("input,select,textarea,button")))) return;
    if (event.code === "KeyI") { event.preventDefault(); setVisible(!visible); }
    if (event.code === "KeyP") { event.preventDefault(); clock.paused = !clock.paused; update(true); }

  });
  return { update: () => update() };
}
