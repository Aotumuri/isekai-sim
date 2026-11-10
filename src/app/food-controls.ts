import { expandGrainStorage, grainStorageCost, GRAIN_STORAGE_MAX } from "../sim/grain-storage";
import { canIrrigate, installIrrigation, IRRIGATION_COST } from "../sim/irrigation";
import type { MesoRegionId } from "../worldgen/meso-region";
import { RATION_POLICIES, setFoodAsylum, setGrainExportProtection, setRationPolicy, type RationPolicy } from "../sim/ration-policy";
import { FAMINE_THRESHOLD, FOOD_INTERVAL, foodReserveSeconds, foodStorageLimit } from "../sim/food-supply";
import { hasTradeAgreement, proposeResourceTrade, resourceReserve, sendGrainAid, TRADE_RESOURCE_VALUES } from "../sim/international-trade";
import { isNationActive } from "../sim/nation-active";
import type { NationRuntime } from "../sim/nation-runtime";
import { getWarDeclarationMode } from "../sim/simulation-settings";
import { FOOD_LEVY_RATES, setSubjectFoodLevy } from "../sim/subject-food-levy";
import { getSubjectOverlord } from "../sim/subject-governments";
import { hasTradeEmbargo, isTradeEmbargoed, setTradeEmbargo } from "../sim/trade-embargo";
import type { WorldState } from "../sim/world-state";
import type { NationId } from "../worldgen/nation";

const quantity = (amount: number): string => amount.toFixed(1);

export function attachFoodControls(root: HTMLElement, world: WorldState, selected: () => NationId,
  partner: () => NationId, feedback: (message: string) => void) {
  root.innerHTML = `
    <h2>国内の食料供給</h2>
    <p data-food-view="stock"></p><p class="society-note" data-food-view="balance"></p>
    <p data-food-view="status"></p><p class="society-note" data-food-view="deaths"></p>
    <p class="society-note">地図の表示設定で農地を確認できます。占領された地区の収穫は国に届きません。</p>
    <label>配給政策 <select data-food-control="rations"><option value="normal">通常 · 100%</option><option value="conserve">節約 · 94%</option><option value="emergency">緊急 · 88%</option></select></label>
    <label><input type="checkbox" data-food-control="asylum"> 近隣からの難民受け入れを拡大</label>
    <p class="society-note" data-food-view="refugees"></p>
    <button type="button" data-food-action="storage">穀物倉庫を拡張</button>
    <p class="society-note" data-food-view="storage"></p>
    <h2>灌漑</h2><label>農地区 <select data-food-control="irrigation"></select></label>
    <button type="button" data-food-action="irrigate">灌漑設備を建設</button>
    <p class="society-note">${IRRIGATION_COST.cash} 資金と鋼材${IRRIGATION_COST.steel}を使い、選んだ地区の収穫を40%増やします。耕作可能で、支配下にあり、補給が届く地区が必要です。</p>
    <label><input type="checkbox" data-food-control="export-protection"> 60秒分の穀物を輸出対象から外す</label>
    <h2>相手国との穀物取引</h2>
    <p class="society-note">不足が迫る国は供給元を自動で探します。輸送には協定、通行可能な経路、輸出できる備蓄が必要です。</p>
    <label>穀物の数量 <input type="number" min="1" max="1000" step="1" value="20" data-food-control="amount"></label>
    <div class="society-actions"><button type="button" data-food-action="buy">穀物を購入</button><button type="button" data-food-action="aid">食料援助を送る</button><button type="button" data-food-action="embargo"></button></div>
    <p class="society-note" data-food-view="trade"></p>
    <h2>従属国からの徴収</h2>
    <label>相手国の収穫から徴収する割合 <select data-food-control="levy">${FOOD_LEVY_RATES.map((rate) => `<option value="${rate}">${Math.round(rate * 100)}%</option>`).join("")}</select></label>
    <p class="society-note" data-food-view="levy"></p>`;
  const view = (name: string) => root.querySelector<HTMLElement>(`[data-food-view="${name}"]`)!;
  const buy = root.querySelector<HTMLButtonElement>('[data-food-action="buy"]')!;
  const aid = root.querySelector<HTMLButtonElement>('[data-food-action="aid"]')!;
  const embargo = root.querySelector<HTMLButtonElement>('[data-food-action="embargo"]')!;
  const amount = root.querySelector<HTMLInputElement>('[data-food-control="amount"]')!;
  const levy = root.querySelector<HTMLSelectElement>('[data-food-control="levy"]')!;
  const rations = root.querySelector<HTMLSelectElement>('[data-food-control="rations"]')!;
  const irrigation = root.querySelector<HTMLSelectElement>('[data-food-control="irrigation"]')!;
  const irrigate = root.querySelector<HTMLButtonElement>('[data-food-action="irrigate"]')!;
  let irrigationKey = "";
  const asylum = root.querySelector<HTMLInputElement>('[data-food-control="asylum"]')!;
  const storage = root.querySelector<HTMLButtonElement>('[data-food-action="storage"]')!;
  const protection = root.querySelector<HTMLInputElement>('[data-food-control="export-protection"]')!;
  const price = () => Number(amount.value) * TRADE_RESOURCE_VALUES.food;

  function update(nation: NationRuntime): void {
    const target = world.nations.find((item) => item.id === partner()), food = nation.food;
    const enabled = world.settings?.foodEnabled !== false;
    const domestic = enabled && !!food && isNationActive(nation);
    view("stock").textContent = domestic ? `穀物備蓄 ${quantity(food.stock)} / ${quantity(foodStorageLimit(food.demand, food.storageLevel))}`
      : enabled ? "稼働中の食料供給はありません。" : "食料シミュレーションは停止中です。";
    const level = food?.storageLevel ?? 0, storageCost = grainStorageCost(level);
    storage.disabled = !domestic || level >= GRAIN_STORAGE_MAX || (nation.treasury?.balance ?? 0) < storageCost.cash ||
      nation.resources.steel < storageCost.steel;
    view("storage").textContent = level >= GRAIN_STORAGE_MAX ? "戦略穀物倉庫は最大まで拡張済みです。"
      : `レベル ${level}/${GRAIN_STORAGE_MAX} · ${storageCost.cash} 資金 ＋ ${storageCost.steel} 鋼材で、通常配給60秒分の備蓄容量を追加できます。`;
    const key = `${nation.id}:${world.territoryVersion}:${world.irrigatedDistricts?.size ?? 0}`;
    if (key !== irrigationKey) {
      irrigationKey = key;
      const previous = irrigation.value;
      const sites = [...(world.agriculturalLand?.keys() ?? [])].filter((id) => canIrrigate(world, nation.id, id));
      irrigation.replaceChildren(...sites.map((id) => new Option(`地区 ${id.replace("meso-", "")}`, id)));
      if (sites.includes(previous as MesoRegionId)) irrigation.value = previous;
    }
    irrigation.disabled = !domestic || !irrigation.options.length;
    irrigate.disabled = irrigation.disabled || (nation.treasury?.balance ?? 0) < IRRIGATION_COST.cash ||
      nation.resources.steel < IRRIGATION_COST.steel;
    asylum.disabled = !domestic;
    asylum.checked = food?.asylum ?? false;
    view("refugees").textContent = domestic ? `直近10秒 · ${(food.refugeesReceived ?? 0).toFixed(2)}人口単位の難民を飢饉・占領地域から受け入れました。食料需要と課税人口が増加します。` : "";
    protection.disabled = !domestic;
    protection.checked = food?.protectGrainExports ?? false;
    rations.disabled = !domestic;
    rations.value = food?.rationPolicy ?? "normal";
    if (domestic) {
      const transfer = food.levy ?? 0;
      const seconds = foodReserveSeconds(food);
      view("balance").textContent = `${FOOD_INTERVAL}秒ごと· 収穫 ${quantity(food.harvest)}· 配給 ${quantity(food.demand)}· 徴収差引 ${transfer >= 0 ? "+" : ""}${quantity(transfer)}.`;
      const status = food.shortageCycles >= FAMINE_THRESHOLD ? "飢饉" : food.rationCoverage + 1e-8 < RATION_POLICIES[food.rationPolicy ?? "normal"] ? "食料不足" : Number.isFinite(seconds) ? "備蓄を使用中" : "配給充足";
      view("status").textContent = `${status}· 前回の配給充足率 ${Math.round(food.rationCoverage * 100)}%${Number.isFinite(seconds) ? ` · 現在の不足が続くと約${seconds}秒で備蓄が尽きます` : ""}.`;
      view("deaths").textContent = food.deaths > 0 ? `飢饉による累計死者：${food.deaths.toFixed(2)}人口単位。` : "";
    } else for (const key of ["balance", "status", "deaths"]) view(key).textContent = "";
    const trade = !!target && target !== nation && isNationActive(nation) && isNationActive(target) &&
      getWarDeclarationMode(world) === "diplomacy" && !!world.settings?.tradeEnabled;
    const ownEmbargo = !!target && hasTradeEmbargo(world, nation.id, target.id);
    const blocked = !!target && isTradeEmbargoed(world, nation.id, target.id);
    embargo.textContent = ownEmbargo ? "禁輸を解除" : "禁輸を実施";
    embargo.disabled = !trade;
    const agreement = !!target && hasTradeAgreement(world, nation.id, target.id);
    const offered = Number(amount.value), validAmount = amount.validity.valid && Number.isFinite(offered) && offered >= 1;
    buy.disabled = !domestic || !trade || blocked || !agreement || !validAmount || !target?.food || !target.treasury ||
      !nation.treasury || nation.treasury.balance < price() + resourceReserve(nation, "cash") ||
      target.food.stock < offered + resourceReserve(target, "food");
    aid.disabled = !domestic || !trade || blocked || !agreement || !validAmount || !target?.food ||
      food.stock < offered + resourceReserve(nation, "food");
    view("trade").textContent = blocked ? "禁輸により、穀物を含む双方向の取引が停止しています。" :
      `${quantity(validAmount ? price() : 0)} 資金 · ${target?.food ? `相手国の輸出可能な穀物 ${quantity(Math.max(0, target.food.stock - resourceReserve(target, "food")))}.` : "相手国に食料備蓄がありません。"}${trade && !agreement ? " 先に通商条約を結んでください。" : ""}`;
    const subject = !!target && getSubjectOverlord(world, target.id) === nation.id;
    levy.disabled = !domestic || !subject;
    levy.value = String(subject ? target.subjectGovernment?.foodLevy ?? 0 : 0);
    view("levy").textContent = subject
      ? "徴収には通行可能な経路が必要です。徴収すると従属国の独立要求が強まり、食料不足を招くことがあります。"
      : "徴収率を設定するには、従属国を外交相手に選んでください。";
  }

  const refresh = () => {
    const nation = world.nations.find((item) => item.id === selected());
    if (nation) update(nation);
  };
  protection.addEventListener("change", () => {
    setGrainExportProtection(world, selected(), protection.checked);
    refresh();
  });
  storage.addEventListener("click", () => {
    const expanded = expandGrainStorage(world, selected());
    feedback(expanded ? "戦略穀物倉庫を拡張しました。" : "倉庫の拡張には、首都への補給と資金が必要です。");
    refresh();
  });
  asylum.addEventListener("change", () => {
    setFoodAsylum(world, selected(), asylum.checked);
    refresh();
  });
  irrigate.addEventListener("click", () => {
    const built = installIrrigation(world, selected(), irrigation.value as MesoRegionId);
    feedback(built ? "灌漑設備が完成しました。" : "灌漑には、安全で補給の届く農地区と資金が必要です。");
    refresh();
  });
  rations.addEventListener("change", () => {
    if (setRationPolicy(world, selected(), rations.value as RationPolicy)) feedback("配給政策を変更しました。");
    refresh();
  });
  amount.addEventListener("input", refresh);
  levy.addEventListener("change", () => {
    if (setSubjectFoodLevy(world, selected(), partner(), Number(levy.value))) feedback("収穫の徴収政策を変更しました。");
    refresh();
  });
  aid.addEventListener("click", () => {
    const sent = sendGrainAid(world, selected(), partner(), Number(amount.value));
    feedback(sent ? "穀物援助を送りました。" : "穀物援助には、通行可能な経路、協定、十分な余剰穀物が必要です。");
    refresh();
  });
  buy.addEventListener("click", () => {
    const success = proposeResourceTrade(world, partner(), selected(), "food", Number(amount.value), "cash", price());
    feedback(success ? "穀物を購入しました。現在輸送中です。" : "発送できませんでした。経路、協定、在庫を確認してください。");
    refresh();
  });
  embargo.addEventListener("click", () => {
    const enabled = !hasTradeEmbargo(world, selected(), partner());
    if (setTradeEmbargo(world, selected(), partner(), enabled)) feedback(enabled ? "禁輸を開始しました。" : "禁輸を解除しました。");
    refresh();
  });
  return { update };
}
