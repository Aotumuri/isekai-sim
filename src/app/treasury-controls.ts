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
    <h2>National treasury</h2><p data-finance-view="balance"></p><p class="society-note" data-finance-view="revenue"></p>
    <div class="society-selectors"><label>Tax rate <select data-finance-control="tax">${TAX_RATES.map((rate) => `<option value="${rate}">${rate}%</option>`).join("")}</select></label>
    <label><input type="checkbox" data-finance-policy="automaticBudget"> Let the government manage the budget</label></div>
    <p class="society-note" data-finance-view="pressure"></p>
    <h2>Public spending</h2>
    <label><input type="checkbox" data-finance-policy="researchFunding"> Fund research grants</label>
    <p class="society-note">Pay 2 cash per additional science, up to 60% more research capacity while materials are available.</p>
    <label><input type="checkbox" data-finance-policy="militaryFunding"> Fund military expansion</label>
    <p class="society-note" data-finance-view="military"></p>
    <button type="button" data-finance-action="relief">Distribute emergency relief</button>
    <p class="society-note" data-finance-view="relief"></p>
    <button type="button" data-finance-action="aid">Send financial aid · ${FINANCIAL_AID} cash</button>
    <p class="society-note" data-finance-view="aid"></p>
    <h2>Public works</h2>
    <div class="society-selectors"><label>Project <select data-finance-control="kind"><option value="city">City</option><option value="port">Port</option></select></label>
    <label>District <select data-finance-control="district"></select></label></div>
    <button type="button" data-finance-action="build">Commission project</button>
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
    view("balance").textContent = treasury ? `Cash reserves: ${cash(treasury.balance)}` : "Treasury unavailable.";
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
    view("aid").textContent = aidIssue ?? "Transfer cash to the selected partner and improve trust.";
    if (!treasury || !active) {
      for (const name of ["revenue", "pressure", "military", "relief", "construction", "spending"]) view(name).textContent = "";
      return;
    }
    const unrest = getDomesticUnrest(world, nation.id), cooldown = Math.max(0, (treasury.nextReliefTick ?? 0) - world.time.slowTick);
    view("revenue").textContent = `Population ${cash(treasury.population)} · Taxable ${cash(treasury.taxablePopulation)} · Last collection +${cash(treasury.lastRevenue)} · Next estimate +${cash(treasury.taxablePopulation * treasury.taxRate / 100)} every ${TAX_COLLECTION_INTERVAL}s.`;
    view("pressure").textContent = `Domestic unrest ${Math.round(unrest.pressure)}/100. Low taxes ease unrest. High taxes can fuel unrest even in peacetime.`;
    view("military").textContent = `${militaryFundingCost(treasury)} cash every ${TAX_COLLECTION_INTERVAL}s · Larger standing force (+25%, rounded up, within the mobilization limit) and shorter recruitment cycles. ${isMilitaryFunded(world, treasury) ? "Currently funded." : "Currently unfunded."}`;
    view("relief").textContent = `${reliefCost(treasury)} cash · Reduces unrest by up to 22 points${cooldown ? ` · Available in ${cooldown}s` : ""}.`;
    action("relief").disabled = unrest.pressure <= 0 || cooldown > 0 || treasury.balance < reliefCost(treasury);
    updateSites(nation.id);
    const project = [...(world.publicWorks ?? [])].find(([, item]) => item.nationId === nation.id);
    const cost = PUBLIC_WORKS[kind()];
    const issue = project ? null : district() ? getPublicWorkIssue(world, nation.id, district(), kind()) : "No empty district available.";
    action("build").disabled = !!project || !!issue;
    view("construction").textContent = project
      ? `${districtName(project[0])} · ${project[1].kind} · ${project[1].remaining}s left${project[1].paused ? " · Paused for safety or supply" : ""}.`
      : `${cost.cash} cash + ${cost.steel} steel + ${cost.fuel} fuel · ${cost.duration}s.${issue ? ` ${issue}` : ""}`;
    view("spending").textContent = `Total spent · Research ${cash(treasury.spent.research)} · Military ${cash(treasury.spent.military)} · Relief ${cash(treasury.spent.relief)} · Construction ${cash(treasury.spent.construction)} · Aid ${cash(treasury.spent.aid ?? 0)}.`;
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
      feedback(sent ? "Financial aid sent." : getFinancialAidIssue(world, id, partner()) ?? "Financial aid unavailable.");
      const nation = world.nations.find((item) => item.id === id);
      if (nation) update(nation);
      return;
    }
    const success = relief ? distributePublicRelief(world, id) : commissionPublicWork(world, id, district(), kind());
    feedback(success ? relief ? "Emergency relief distributed." : "Construction commissioned." : "The current conditions no longer allow this spending.");
    const nation = world.nations.find((item) => item.id === id);
    if (nation) update(nation);
  });
  return { update };
}
