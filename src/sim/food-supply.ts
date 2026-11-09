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
export const foodStorageLimit = (demand: number): number => 20 + demand * 18;

export interface NationalFoodSupply {
  stock: number;
  harvest: number;
  levy?: number;
  demand: number;
  rationCoverage: number;
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
      total.harvest += (world.agriculturalLand?.get(id)?.harvest ?? 0) * annexedOutputFactor(world, owner, id);
    }
    totals.set(owner, total);
  }
  return totals;
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
    food.rationCoverage = Math.min(1, available / demand);
    food.stock = Math.min(foodStorageLimit(demand), Math.max(0, available - demand));
    const wasFamine = food.shortageCycles >= FAMINE_THRESHOLD;
    food.shortageCycles = food.rationCoverage < 0.9 ? food.shortageCycles + 1 : Math.max(0, food.shortageCycles - 2);
    const famine = food.shortageCycles >= FAMINE_THRESHOLD;
    if (famine && food.rationCoverage < 0.9) {
      const severity = (0.9 - food.rationCoverage) / 0.9;
      food.deaths += applyFamineDeaths(world, ids, severity * 0.035);
      world.populationRevision = (world.populationRevision ?? 0) + 1;
    }
    if (famine !== wasFamine) recordSimulationEvent(world, { category: "politics", nationIds: [nation.id],
      message: famine ? `Famine in ${nation.id}: only ${Math.round(food.rationCoverage * 100)}% of rations were supplied.`
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
  return { ...parent, stock, harvest: parent.harvest * share, demand: parent.demand * share, levy: 0, deaths: 0 };
}
