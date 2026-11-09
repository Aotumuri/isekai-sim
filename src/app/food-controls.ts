import { expandGrainStorage, grainStorageCost, GRAIN_STORAGE_MAX } from "../sim/grain-storage";
import { canIrrigate, installIrrigation, IRRIGATION_COST } from "../sim/irrigation";
import type { MesoRegionId } from "../worldgen/meso-region";
import { RATION_POLICIES, setFoodAsylum, setGrainExportProtection, setRationPolicy, type RationPolicy } from "../sim/ration-policy";
import { FAMINE_THRESHOLD, FOOD_INTERVAL, foodStorageLimit } from "../sim/food-supply";
import { hasTradeAgreement, proposeResourceTrade, resourceReserve, TRADE_RESOURCE_VALUES } from "../sim/international-trade";
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
    <h2>National food supply</h2>
    <p data-food-view="stock"></p><p class="society-note" data-food-view="balance"></p>
    <p data-food-view="status"></p><p class="society-note" data-food-view="deaths"></p>
    <p class="society-note">Open Display settings on the map to see agricultural land. Occupied districts stop supplying the national harvest.</p>
    <label>Ration policy <select data-food-control="rations"><option value="normal">Normal · 100%</option><option value="conserve">Conserve · 94%</option><option value="emergency">Emergency · 88%</option></select></label>
    <label><input type="checkbox" data-food-control="asylum"> Expand refugee reception from neighboring crises</label>
    <p class="society-note" data-food-view="refugees"></p>
    <button type="button" data-food-action="storage">Expand grain storage</button>
    <p class="society-note" data-food-view="storage"></p>
    <h2>Irrigation</h2><label>Farm district <select data-food-control="irrigation"></select></label>
    <button type="button" data-food-action="irrigate">Build irrigation</button>
    <p class="society-note">${IRRIGATION_COST.cash} cash and ${IRRIGATION_COST.steel} steel · +40% harvest in the selected district. Requires workable land, control and supply.</p>
    <label><input type="checkbox" data-food-control="export-protection"> Protect 60 seconds of grain from export</label>
    <h2>Grain trade with selected partner</h2>
    <p class="society-note">Governments with a looming shortage look for suppliers automatically. Shipments require an agreement, open route and exportable stock.</p>
    <label>Grain to buy <input type="number" min="1" max="1000" step="1" value="20" data-food-control="amount"></label>
    <div class="society-actions"><button type="button" data-food-action="buy">Buy grain</button><button type="button" data-food-action="embargo"></button></div>
    <p class="society-note" data-food-view="trade"></p>
    <h2>Subject requisitions</h2>
    <label>Share of the selected partner’s harvest <select data-food-control="levy">${FOOD_LEVY_RATES.map((rate) => `<option value="${rate}">${Math.round(rate * 100)}%</option>`).join("")}</select></label>
    <p class="society-note" data-food-view="levy"></p>`;
  const view = (name: string) => root.querySelector<HTMLElement>(`[data-food-view="${name}"]`)!;
  const buy = root.querySelector<HTMLButtonElement>('[data-food-action="buy"]')!;
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
    view("stock").textContent = domestic ? `Grain stockpile ${quantity(food.stock)} / ${quantity(foodStorageLimit(food.demand, food.storageLevel))}`
      : enabled ? "No active food supply." : "Food simulation is paused.";
    const level = food?.storageLevel ?? 0, storageCost = grainStorageCost(level);
    storage.disabled = !domestic || level >= GRAIN_STORAGE_MAX || (nation.treasury?.balance ?? 0) < storageCost.cash ||
      nation.resources.steel < storageCost.steel;
    view("storage").textContent = level >= GRAIN_STORAGE_MAX ? "Strategic grain storage fully expanded."
      : `Level ${level}/${GRAIN_STORAGE_MAX} · ${storageCost.cash} cash + ${storageCost.steel} steel for 60 more seconds of full-ration capacity.`;
    const key = `${nation.id}:${world.territoryVersion}:${world.irrigatedDistricts?.size ?? 0}`;
    if (key !== irrigationKey) {
      irrigationKey = key;
      const previous = irrigation.value;
      const sites = [...(world.agriculturalLand?.keys() ?? [])].filter((id) => canIrrigate(world, nation.id, id));
      irrigation.replaceChildren(...sites.map((id) => new Option(`District ${id.replace("meso-", "")}`, id)));
      if (sites.includes(previous as MesoRegionId)) irrigation.value = previous;
    }
    irrigation.disabled = !domestic || !irrigation.options.length;
    irrigate.disabled = irrigation.disabled || (nation.treasury?.balance ?? 0) < IRRIGATION_COST.cash ||
      nation.resources.steel < IRRIGATION_COST.steel;
    asylum.disabled = !domestic;
    asylum.checked = food?.asylum ?? false;
    view("refugees").textContent = domestic ? `Last 10s · ${(food.refugeesReceived ?? 0).toFixed(2)} population units received from famine or occupation. Arrivals increase food demand and the tax base.` : "";
    protection.disabled = !domestic;
    protection.checked = food?.protectGrainExports ?? false;
    rations.disabled = !domestic;
    rations.value = food?.rationPolicy ?? "normal";
    if (domestic) {
      const transfer = food.levy ?? 0;
      const deficit = Math.max(0, food.demand * RATION_POLICIES[food.rationPolicy ?? "normal"] - food.harvest - transfer);
      view("balance").textContent = `Per ${FOOD_INTERVAL}s · Harvest ${quantity(food.harvest)} · Rations ${quantity(food.demand)} · Net requisitions ${transfer >= 0 ? "+" : ""}${quantity(transfer)}.`;
      const status = food.shortageCycles >= FAMINE_THRESHOLD ? "Famine" : food.rationCoverage + 1e-8 < RATION_POLICIES[food.rationPolicy ?? "normal"] ? "Food shortage" : deficit > 0 ? "Using reserves" : "Rations met";
      view("status").textContent = `${status} · Last ration coverage ${Math.round(food.rationCoverage * 100)}%${deficit > 0 ? ` · Reserves last about ${Math.floor(food.stock / deficit * FOOD_INTERVAL)}s at the current deficit` : ""}.`;
      view("deaths").textContent = food.deaths > 0 ? `Famine deaths to date: ${food.deaths.toFixed(2)} population units.` : "";
    } else for (const key of ["balance", "status", "deaths"]) view(key).textContent = "";
    const trade = !!target && target !== nation && isNationActive(nation) && isNationActive(target) &&
      getWarDeclarationMode(world) === "diplomacy" && !!world.settings?.tradeEnabled;
    const ownEmbargo = !!target && hasTradeEmbargo(world, nation.id, target.id);
    const blocked = !!target && isTradeEmbargoed(world, nation.id, target.id);
    embargo.textContent = ownEmbargo ? "Lift embargo" : "Impose trade embargo";
    embargo.disabled = !trade;
    const agreement = !!target && hasTradeAgreement(world, nation.id, target.id);
    const offered = Number(amount.value), validAmount = amount.validity.valid && Number.isFinite(offered) && offered >= 1;
    buy.disabled = !domestic || !trade || blocked || !agreement || !validAmount || !target?.food || !target.treasury ||
      !nation.treasury || nation.treasury.balance < price() + resourceReserve(nation, "cash") ||
      target.food.stock < offered + resourceReserve(target, "food");
    view("trade").textContent = blocked ? "An embargo blocks trade in both directions, including grain." :
      `${quantity(validAmount ? price() : 0)} cash · ${target?.food ? `Partner exportable grain ${quantity(Math.max(0, target.food.stock - resourceReserve(target, "food")))}.` : "Partner has no food stockpile."}${trade && !agreement ? " Negotiate a trade pact first." : ""}`;
    const subject = !!target && getSubjectOverlord(world, target.id) === nation.id;
    levy.disabled = !domestic || !subject;
    levy.value = String(subject ? target.subjectGovernment?.foodLevy ?? 0 : 0);
    view("levy").textContent = subject
      ? "Requisitions require an open route. Taking harvests increases the subject’s independence pressure and can leave its population short of food."
      : "Select one of this nation’s subjects as the diplomatic partner to set a levy.";
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
    feedback(expanded ? "Strategic grain storage expanded." : "Storage expansion requires a supplied capital and available funds.");
    refresh();
  });
  asylum.addEventListener("change", () => {
    setFoodAsylum(world, selected(), asylum.checked);
    refresh();
  });
  irrigate.addEventListener("click", () => {
    const built = installIrrigation(world, selected(), irrigation.value as MesoRegionId);
    feedback(built ? "Irrigation completed." : "Irrigation requires a safe, supplied farm district and available funds.");
    refresh();
  });
  rations.addEventListener("change", () => {
    if (setRationPolicy(world, selected(), rations.value as RationPolicy)) feedback("Ration policy updated.");
    refresh();
  });
  amount.addEventListener("input", refresh);
  levy.addEventListener("change", () => {
    if (setSubjectFoodLevy(world, selected(), partner(), Number(levy.value))) feedback("Harvest requisition policy updated.");
    refresh();
  });
  buy.addEventListener("click", () => {
    const success = proposeResourceTrade(world, partner(), selected(), "food", Number(amount.value), "cash", price());
    feedback(success ? "Grain order dispatched. The cargo is in transit." : "The order could not be dispatched. Check the route, agreement and available stock.");
    refresh();
  });
  embargo.addEventListener("click", () => {
    const enabled = !hasTradeEmbargo(world, selected(), partner());
    if (setTradeEmbargo(world, selected(), partner(), enabled)) feedback(enabled ? "Trade embargo imposed." : "Trade embargo lifted.");
    refresh();
  });
  return { update };
}
