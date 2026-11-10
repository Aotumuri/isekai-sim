import { IRRIGATION_MULTIPLIER } from "./irrigation";
import { RATION_POLICIES, type RationPolicy } from "./ration-policy";
import { collectSubjectFoodLevies } from "./subject-food-levy";
import type { MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import { annexedOutputFactor } from "./annexation";
import { isNationActive } from "./nation-active";
import { POPULATION_DIMENSIONS } from "./regional-population";
import { recordSimulationEvent } from "./simulation-settings";
import { getOwnerByMesoId } from "./world-cache";
import type { WorldState } from "./world-state";

export const FOOD_INTERVAL = 10;
export const FAMINE_THRESHOLD = 3;
export const foodStorageLimit = (demand: number, level = 0): number => 20 + demand * (18 + 6 * level);

export interface NationalFoodSupply {
  stock: number;
  harvest: number;
  levy?: number;
  demand: number;
  rationCoverage: number;
  protectGrainExports?: boolean;
  storageLevel?: number;
  asylum?: boolean;
  refugeesReceived?: number;
  rationPolicy?: RationPolicy;
  reserveWarning?: boolean;
  shortageCycles: number;
  deaths: number;
}

interface FoodDistricts {
  ids: MesoRegionId[];
  harvest: number;
  demand: number;
}

function collectFoodDistricts(world: WorldState): Map<NationId, FoodDistricts> {
  const totals = new Map<NationId, FoodDistricts>();
  for (const [id, owner] of getOwnerByMesoId(world)) {
    const population = world.regionalPopulations?.get(id);
    if (!population) continue;
    const total = totals.get(owner) ?? { ids: [], harvest: 0, demand: 0 };
    total.ids.push(id);
    total.demand += population.size * 0.5;
    const occupier = world.occupation.mesoById.get(id);
    if (!occupier || occupier === owner) {
      total.harvest += (world.agriculturalLand?.get(id)?.harvest ?? 0) * annexedOutputFactor(world, owner, id) *
        (world.irrigatedDistricts?.has(id) ? IRRIGATION_MULTIPLIER : 1);
    }
    totals.set(owner, total);
  }
  return totals;
}

export function foodReserveSeconds(food: NationalFoodSupply): number {
  const ration = RATION_POLICIES[food.rationPolicy ?? "normal"];
  const deficit = food.demand * ration - food.harvest - (food.levy ?? 0);
  return deficit > 0 ? Math.floor(food.stock / deficit * FOOD_INTERVAL) : Infinity;
}

function updateReserveWarning(world: WorldState, id: NationId, food: NationalFoodSupply): void {
  const seconds = foodReserveSeconds(food);
  if (food.reserveWarning && seconds >= 120) food.reserveWarning = false;
  if (food.reserveWarning || seconds > 60 || food.shortageCycles >= FAMINE_THRESHOLD) return;
  food.reserveWarning = true;
  recordSimulationEvent(world, { category: "politics", nationIds: [id],
    message: `${id}の穀物備蓄は現在の収穫と配給を続けると約${seconds}秒で尽きます。` });
}

function applyFamineDeaths(world: WorldState, districts: MesoRegionId[], mortality: number): number {
  let deaths = 0;
  for (const id of districts) {
    const population = world.regionalPopulations?.get(id);
    if (!population) continue;
    deaths += population.size * mortality;
    population.size *= 1 - mortality;
    for (const dimension of POPULATION_DIMENSIONS) {
      population[dimension] = population[dimension].map((count) => count * (1 - mortality));
    }
  }
  return deaths;
}

export function updateFoodSupply(world: WorldState): void {
  if (world.settings?.foodEnabled === false || !world.agriculturalLand || world.time.slowTick % FOOD_INTERVAL !== 0 ||
    world.lastFoodTick === world.time.slowTick) return;
  world.lastFoodTick = world.time.slowTick;
  const totals = collectFoodDistricts(world);
  const levies = collectSubjectFoodLevies(world, totals);
  for (const nation of world.nations) {
    const districts = totals.get(nation.id);
    if (!districts || !isNationActive(nation)) continue;
    const { demand, harvest, ids } = districts;
    const food = nation.food ??= { stock: demand * (world.time.slowTick === 0 ? 12 : 0), harvest, demand,
      rationCoverage: 1, shortageCycles: 0, deaths: 0 };
    food.harvest = harvest;
    food.levy = levies.get(nation.id) ?? 0;
    food.demand = demand;
    if (world.time.slowTick === 0 || demand <= 0) continue;
    const available = food.stock + harvest + food.levy;
    const ration = RATION_POLICIES[food.rationPolicy ?? "normal"];
    const consumed = Math.min(available, demand * ration);
    food.rationCoverage = consumed / demand;
    food.stock = Math.min(foodStorageLimit(demand, food.storageLevel), available - consumed);
    const wasFamine = food.shortageCycles >= FAMINE_THRESHOLD;
    const famineCoverage = Math.min(0.9, ration - 0.01);
    food.shortageCycles = food.rationCoverage < famineCoverage ? food.shortageCycles + 1 : Math.max(0, food.shortageCycles - 2);
    const famine = food.shortageCycles >= FAMINE_THRESHOLD;
    updateReserveWarning(world, nation.id, food);
    if (famine && food.rationCoverage < famineCoverage) {
      const severity = (famineCoverage - food.rationCoverage) / famineCoverage;
      food.deaths += applyFamineDeaths(world, ids, severity * 0.035);
      world.populationRevision = (world.populationRevision ?? 0) + 1;
    }
    if (famine !== wasFamine) recordSimulationEvent(world, { category: "politics", nationIds: [nation.id],
      message: famine ? `${nation.id}で飢饉が発生しました。配給の充足率は${Math.round(food.rationCoverage * 100)}%です。`
        : `Food deliveries have eased the famine in ${nation.id}.` });
  }
}

export function isFamineRevolution(world: WorldState, food?: NationalFoodSupply): boolean {
  return world.settings?.foodEnabled !== false && !!food && food.shortageCycles >= 8 && food.rationCoverage < 0.7;
}

export function splitFoodSupply(parent: NationalFoodSupply | undefined, share: number): NationalFoodSupply | undefined {
  if (!parent) return undefined;
  const stock = parent.stock * Math.max(0, Math.min(1, share));
  parent.stock -= stock;
  return { ...parent, stock, harvest: parent.harvest * share, demand: parent.demand * share, levy: 0, deaths: 0, refugeesReceived: 0, storageLevel: 0, reserveWarning: false };
}
