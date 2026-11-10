import { getManualGovernmentId } from "../sim/player-nation";
import { FINANCIAL_AID, getFinancialAidIssue, sendFinancialAid } from "../sim/financial-aid";
import { getDomesticUnrest } from "../sim/domestic-unrest";
import { isMilitaryFunded, militaryFundingCost } from "../sim/military-funding";
import { isNationActive } from "../sim/nation-active";
import type { NationRuntime } from "../sim/nation-runtime";
import { commissionPublicWork, getPublicWorkIssue, PUBLIC_WORKS, type PublicWorkKind } from "../sim/public-works";
import { distributePublicRelief, reliefCost } from "../sim/public-relief";
import { isBudgetDelegated, setTaxRate, setTreasuryPolicy, TAX_COLLECTION_INTERVAL, TAX_RATES } from "../sim/treasury";
import { getMesoById, getOwnerByMesoId } from "../sim/world-cache";
import type { WorldState } from "../sim/world-state";
import type { MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";

const districtName = (id: MesoRegionId): string => `District ${id.replace("meso-", "")}`;
const cash = (value: number): string => value.toFixed(1);

export function attachTreasuryControls(root: HTMLElement, world: WorldState, selected: () => NationId, partner: () => NationId,
  feedback: (message: string) => void) {
  root.innerHTML = `
    <h2>国庫</h2><p data-finance-view="balance"></p><p class="society-note" data-finance-view="revenue"></p>
    <div class="society-selectors"><label>税率 <select data-finance-control="tax">${TAX_RATES.map((rate) => `<option value="${rate}">${rate}%</option>`).join("")}</select></label>
    <label><input type="checkbox" data-finance-policy="automaticBudget"> 予算配分を政府に任せる</label></div>
    <p class="society-note" data-finance-view="pressure"></p>
    <h2>公共支出</h2>
    <label><input type="checkbox" data-finance-policy="researchFunding"> 研究助成に資金を出す</label>
    <p class="society-note">資材がある間、追加の研究力1につき資金2を払い、研究力を最大60%引き上げます。</p>
    <label><input type="checkbox" data-finance-policy="militaryFunding"> 軍備拡張に資金を出す</label>
    <p class="society-note" data-finance-view="military"></p>
    <button type="button" data-finance-action="relief">緊急救済を実施</button>
    <p class="society-note" data-finance-view="relief"></p>
    <button type="button" data-finance-action="aid">資金援助を送る · ${FINANCIAL_AID} cash</button>
    <p class="society-note" data-finance-view="aid"></p>
    <h2>公共事業</h2>
    <div class="society-selectors"><label>事業 <select data-finance-control="kind"><option value="city">都市</option><option value="port">港</option></select></label>
    <label>地区 <select data-finance-control="district"></select></label></div>
    <button type="button" data-finance-action="build">事業を発注</button>
    <p class="society-note" data-finance-view="construction"></p>
    <p class="society-note" data-finance-view="spending"></p>`;
  const control = (name: string) => root.querySelector<HTMLSelectElement>(`[data-finance-control="${name}"]`)!;
  const view = (name: string) => root.querySelector<HTMLElement>(`[data-finance-view="${name}"]`)!;
  const action = (name: string) => root.querySelector<HTMLButtonElement>(`[data-finance-action="${name}"]`)!;
  const policies = root.querySelectorAll<HTMLInputElement>("[data-finance-policy]");
  const kind = () => control("kind").value as PublicWorkKind;
  const district = () => control("district").value as MesoRegionId;
  let siteKey = "";

  function updateSites(id: NationId): void {
    const key = `${id}:${kind()}:${world.territoryVersion}:${world.buildingVersion}`;
    if (siteKey === key) return;
    siteKey = key;
    const previous = district(), regions = getMesoById(world), owners = getOwnerByMesoId(world);
    const options = world.mesoRegions.filter((region) => region.type !== "sea" && region.building === null &&
      owners.get(region.id) === id && (kind() !== "port" || region.neighbors.some(({ id: neighbor }) => regions.get(neighbor)?.type === "sea")));
    control("district").replaceChildren(...options.map((region) => new Option(districtName(region.id), region.id)));
    if (options.some((region) => region.id === previous)) control("district").value = previous;
  }

  function update(nation: NationRuntime): void {
    const treasury = nation.treasury, active = isNationActive(nation);
    view("balance").textContent = treasury ? `国庫残高： ${cash(treasury.balance)}` : "国庫を利用できません。";
    const delegated = isBudgetDelegated(world, nation.id, treasury);
    for (const input of policies) {
      const policy = input.dataset.financePolicy as "automaticBudget" | "researchFunding" | "militaryFunding";
      input.checked = policy === "automaticBudget" ? delegated : !!treasury?.[policy];
      input.disabled = !treasury || !active || (policy === "automaticBudget" ? getManualGovernmentId(world) === nation.id : delegated);
    }
    control("tax").disabled = !treasury || !active || delegated;
    control("tax").value = String(treasury?.taxRate ?? 15);
    control("kind").disabled = control("district").disabled = !active;
    action("build").disabled = action("relief").disabled = true;
    const aidIssue = getFinancialAidIssue(world, nation.id, partner());
    action("aid").disabled = !!aidIssue;
    view("aid").textContent = aidIssue ?? "相手国に資金を送り、信頼を高めます。";
    if (!treasury || !active) {
      for (const name of ["revenue", "pressure", "military", "relief", "construction", "spending"]) view(name).textContent = "";
      return;
    }
    const unrest = getDomesticUnrest(world, nation.id), cooldown = Math.max(0, (treasury.nextReliefTick ?? 0) - world.time.slowTick);
    view("revenue").textContent = `人口 ${cash(treasury.population)}· 課税対象 ${cash(treasury.taxablePopulation)}· 前回の徴税 +${cash(treasury.lastRevenue)}· 次回の見込み +${cash(treasury.taxablePopulation * treasury.taxRate / 100)}（${TAX_COLLECTION_INTERVAL}秒ごと）。`;
    view("pressure").textContent = `国内不安 ${Math.round(unrest.pressure)}/100. 減税は不安を和らげます。高い税率は平時でも不安を招きます。`;
    view("military").textContent = `${militaryFundingCost(treasury)} ${TAX_COLLECTION_INTERVAL}秒ごとに資金 · 動員上限の範囲で常備軍が25%増え（端数切り上げ）、徴兵の間隔が短くなります。 ${isMilitaryFunded(world, treasury) ? "資金を拠出中です。" : "資金を拠出していません。"}`;
    view("relief").textContent = `${reliefCost(treasury)} 資金 · 国内不安を最大22ポイント緩和${cooldown ? `· 利用可能まで ${cooldown}s` : ""}.`;
    action("relief").disabled = unrest.pressure <= 0 || cooldown > 0 || treasury.balance < reliefCost(treasury);
    updateSites(nation.id);
    const project = [...(world.publicWorks ?? [])].find(([, item]) => item.nationId === nation.id);
    const cost = PUBLIC_WORKS[kind()];
    const issue = project ? null : district() ? getPublicWorkIssue(world, nation.id, district(), kind()) : "No empty district available.";
    action("build").disabled = !!project || !!issue;
    view("construction").textContent = project
      ? `${districtName(project[0])} · ${project[1].kind} · ${project[1].remaining}s left${project[1].paused ? " · Paused for safety or supply" : ""}.`
      : `${cost.cash} 資金 ＋ ${cost.steel} 鋼材 ＋ ${cost.fuel} 燃料 · ${cost.duration}s.${issue ? ` ${issue}` : ""}`;
    view("spending").textContent = `累計支出 · 研究 ${cash(treasury.spent.research)} · 軍事 ${cash(treasury.spent.military)} · 救済 ${cash(treasury.spent.relief)} · 建設 ${cash(treasury.spent.construction)} · 援助 ${cash(treasury.spent.aid ?? 0)}.`;
  }

  root.addEventListener("change", (event) => {
    const input = event.target as HTMLInputElement | HTMLSelectElement;
    const id = selected();
    if (input.dataset.financeControl === "tax") setTaxRate(world, id, Number(input.value));
    if (input instanceof HTMLInputElement && input.dataset.financePolicy) {
      setTreasuryPolicy(world, id, input.dataset.financePolicy as "automaticBudget" | "researchFunding" | "militaryFunding", input.checked);
    }
    const nation = world.nations.find((item) => item.id === id);
    if (nation) update(nation);
  });
  root.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-finance-action]");
    if (!button) return;
    const id = selected(), relief = button.dataset.financeAction === "relief";
    if (button.dataset.financeAction === "aid") {
      const sent = sendFinancialAid(world, id, partner());
      feedback(sent ? "資金援助を送りました。" : getFinancialAidIssue(world, id, partner()) ?? "資金援助を行えません。");
      const nation = world.nations.find((item) => item.id === id);
      if (nation) update(nation);
      return;
    }
    const success = relief ? distributePublicRelief(world, id) : commissionPublicWork(world, id, district(), kind());
    feedback(success ? relief ? "緊急救済を実施しました。" : "建設を発注しました。" : "現在の条件では支出できません。");
    const nation = world.nations.find((item) => item.id === id);
    if (nation) update(nation);
  });
  return { update };
}
