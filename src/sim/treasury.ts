import type { NationId } from "../worldgen/nation";
import { isNationActive } from "./nation-active";
import { getOwnerByMesoId } from "./world-cache";
import type { WorldState } from "./world-state";

export const TAX_RATES = [5, 10, 15, 20, 25, 30] as const;
export type TaxRate = typeof TAX_RATES[number];
export type SpendingCategory = "research" | "military" | "relief" | "construction";

export interface NationalTreasury {
  balance: number;
  taxRate: TaxRate;
  population: number;
  taxablePopulation: number;
  lastRevenue: number;
  nextReliefTick?: number;
  researchFunding: boolean;
  automaticBudget?: boolean;
  militaryFunding: boolean;
  militaryFundedUntil?: number;
  spent: Record<SpendingCategory, number>;
}

export const TAX_COLLECTION_INTERVAL = 10;

function populationByNation(world: WorldState) {
  const totals = new Map<NationId, { population: number; taxablePopulation: number }>();
  for (const [id, owner] of getOwnerByMesoId(world)) {
    const population = world.regionalPopulations?.get(id)?.size;
    if (!population) continue;
    const total = totals.get(owner) ?? { population: 0, taxablePopulation: 0 };
    total.population += population;
    const controller = world.occupation.mesoById.get(id);
    if (!controller || controller === owner) total.taxablePopulation += population;
    totals.set(owner, total);
  }
  return totals;
}

function createTreasury(balance: number): NationalTreasury {
  return { balance, taxRate: 15, population: 0, taxablePopulation: 0, lastRevenue: 0,
    researchFunding: false, militaryFunding: false,
    spent: { research: 0, military: 0, relief: 0, construction: 0 } };
}

export function splitTreasury(parent: NationalTreasury | undefined, share: number): NationalTreasury | undefined {
  if (!parent) return undefined;
  const allocated = parent.balance * Math.max(0, Math.min(1, share));
  parent.balance -= allocated;
  return { ...createTreasury(allocated), taxRate: parent.taxRate, automaticBudget: parent.automaticBudget };
}

export function updateTreasuries(world: WorldState): void {
  if (!world.regionalPopulations || world.time.slowTick % TAX_COLLECTION_INTERVAL !== 0 ||
    world.lastTaxCollectionTick === world.time.slowTick) return;
  world.lastTaxCollectionTick = world.time.slowTick;
  const totals = populationByNation(world);
  for (const nation of world.nations) {
    if (!isNationActive(nation)) {
      if (nation.treasury) Object.assign(nation.treasury, { population: 0, taxablePopulation: 0, lastRevenue: 0 });
      continue;
    }
    const { population, taxablePopulation } = totals.get(nation.id) ?? { population: 0, taxablePopulation: 0 };
    const treasury = nation.treasury ??= createTreasury(20 + population * 0.75);
    treasury.population = population;
    treasury.taxablePopulation = taxablePopulation;
    treasury.lastRevenue = world.time.slowTick === 0 ? 0 : taxablePopulation * treasury.taxRate / 100;
    treasury.balance += treasury.lastRevenue;
  }
}

export function setTaxRate(world: WorldState, id: NationId, rate: number): boolean {
  const nation = world.nations.find((item) => item.id === id);
  if (!nation?.treasury || !isNationActive(nation) || !TAX_RATES.includes(rate as TaxRate)) return false;
  nation.treasury.taxRate = rate as TaxRate;
  return true;
}

export function spendTreasury(treasury: NationalTreasury | undefined, category: SpendingCategory, amount: number): boolean {
  if (!treasury || !Number.isFinite(amount) || amount <= 0 || treasury.balance < amount) return false;
  treasury.balance -= amount;
  treasury.spent[category] += amount;
  return true;
}

export function taxUnrestPerTick(treasury?: NationalTreasury): number {
  return treasury ? (treasury.taxRate - 15) * (treasury.taxRate > 15 ? 0.08 : 0.04) : 0;
}
