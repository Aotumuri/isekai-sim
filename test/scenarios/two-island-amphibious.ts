import { WORLD_BALANCE } from "../../src/data/balance";
import { createUnitForType } from "../../src/sim/create-units";
import { createProductionDiagnosticsState } from "../../src/sim/production";
import { createUnitId } from "../../src/sim/unit";
import { createWorldCache } from "../../src/sim/world-cache";
import { declareWar } from "../../src/sim/war-state";
import { createMacroRegionId, type MacroRegion } from "../../src/worldgen/macro-region";
import type { MesoRegion, MesoRegionId } from "../../src/worldgen/meso-region";
import type { NationId } from "../../src/worldgen/nation";
import type { ScenarioSetup } from "./types";

const INITIAL_LAND_UNITS = 18;
const INITIAL_TRANSPORTS = 2;
const INITIAL_ESCORTS = 1;
const INITIAL_RESOURCE_STOCK = 25_000;

/** Diagnostic-only topology. It deliberately changes scenario state, never
 * production simulation rules, so both combatants exercise the normal AI. */
export const setupTwoIslandAmphibious: ScenarioSetup = (world) => {
  const sortedX = [...world.mesoRegions].sort((a, b) => a.center.x - b.center.x || compareIds(a.id, b.id));
  const lower = sortedX[Math.floor(sortedX.length * 0.43)]?.center.x ?? world.width * 0.43;
  const upper = sortedX[Math.floor(sortedX.length * 0.57)]?.center.x ?? world.width * 0.57;
  for (const region of world.mesoRegions) {
    region.type = region.center.x < lower || region.center.x > upper ? "land" : "sea";
    region.building = null;
    region.resource = null;
  }

  const left = largestComponent(world.mesoRegions, (region) => region.type !== "sea" && region.center.x < lower);
  const right = largestComponent(world.mesoRegions, (region) => region.type !== "sea" && region.center.x > upper);
  if (left.length < 8 || right.length < 8) {
    throw new Error("two-island-amphibious requires two land components of at least eight regions");
  }
  const retainedLand = new Set([...left, ...right]);
  for (const region of world.mesoRegions) {
    if (!retainedLand.has(region.id)) region.type = "sea";
  }
  const leftIds = new Set(left);
  const rightIds = new Set(right);
  // Voronoi meso adjacency can jump across the deliberately widened sea band.
  // Remove only those synthetic cross-island edges so no land border exists.
  for (const region of world.mesoRegions) {
    if (leftIds.has(region.id)) {
      region.neighbors = region.neighbors.filter((neighbor) => !rightIds.has(neighbor.id));
    } else if (rightIds.has(region.id)) {
      region.neighbors = region.neighbors.filter((neighbor) => !leftIds.has(neighbor.id));
    }
  }

  const nationA = world.nations[0];
  const nationB = world.nations[1];
  if (!nationA || !nationB) throw new Error("two-island-amphibious requires two generated nations");
  const combatants: [NationId, NationId] = [nationA.id, nationB.id];
  const [portA, portB] = selectReachablePortPair(world.mesoRegions, left, right);
  const islandData = [
    configureIsland(world.mesoRegions, left, portA, true),
    configureIsland(world.mesoRegions, right, portB, false),
  ] as const;

  const macros: MacroRegion[] = islandData.map((island, index) => ({
    id: createMacroRegionId(index),
    nationId: combatants[index],
    mesoRegionIds: [...island.regionIds],
    isCore: true,
  }));
  world.macroRegions = macros;
  world.nations = [nationA, nationB];
  for (let index = 0; index < world.nations.length; index += 1) {
    const nation = world.nations[index]!;
    const island = islandData[index]!;
    nation.capitalMesoId = island.capitalId;
    nation.macroRegionIds = [macros[index]!.id];
    nation.unitRoles = { defenseUnitIds: [], occupationUnitIds: [] };
    nation.capitalFallCount = 0;
    nation.surrenderScore = 0;
    nation.initialCityCount = 3;
    nation.warCooperation = WORLD_BALANCE.war.cooperation.max;
    nation.warCooperationBoost = 0;
    // Let the equal starting forces assemble before the normal production
    // cadence begins; otherwise both sides grow the reaction estimate faster
    // than their first fleets can physically reach port.
    nation.nextUnitProductionTick = 500;
    nation.nextWarDeclarationTick = Number.POSITIVE_INFINITY;
    nation.resources = {
      steel: INITIAL_RESOURCE_STOCK,
      fuel: INITIAL_RESOURCE_STOCK,
      manpower: INITIAL_RESOURCE_STOCK,
      weapons: INITIAL_RESOURCE_STOCK,
    };
    nation.resourceFlow = {
      income: { steel: 0, fuel: 0, manpower: 0, weapons: 0 },
      usage: { steel: 0, fuel: 0, manpower: 0, weapons: 0 },
      delta: { steel: 0, fuel: 0, manpower: 0, weapons: 0 },
      lastTick: -1,
    };
  }

  world.units = [];
  world.unitIdCounter = 0;
  for (let nationIndex = 0; nationIndex < combatants.length; nationIndex += 1) {
    const nationId = combatants[nationIndex]!;
    const positions = islandData[nationIndex]!.garrisonIds;
    for (let index = 0; index < INITIAL_LAND_UNITS; index += 1) {
      world.units.push(createUnitForType(
        createUnitId(world.unitIdCounter++), nationId,
        positions[index % positions.length]!, index % 6 === 0 ? "Tank" : "Infantry",
      ));
    }
    for (let index = 0; index < INITIAL_TRANSPORTS; index += 1) {
      world.units.push(createUnitForType(
        createUnitId(world.unitIdCounter++), nationId,
        islandData[nationIndex]!.portId, "TransportShip",
      ));
    }
    for (let index = 0; index < INITIAL_ESCORTS; index += 1) {
      world.units.push(createUnitForType(
        createUnitId(world.unitIdCounter++), nationId,
        islandData[nationIndex]!.portId, "CombatShip",
      ));
    }
    world.nations[nationIndex]!.initialUnitCount =
      INITIAL_LAND_UNITS + INITIAL_TRANSPORTS + INITIAL_ESCORTS;
  }

  world.wars = [];
  if (!declareWar(world.wars, nationA.id, nationB.id, world.time.fastTick, true)) {
    throw new Error("two-island-amphibious war could not be created");
  }
  world.battles = [];
  world.occupation.mesoById.clear();
  world.occupation.macroById.clear();
  world.occupation.dirtyMesoIds.clear();
  world.occupation.version += 1;
  world.mapVersion += 1;
  world.territoryVersion += 1;
  world.buildingVersion += 1;
  world.cache = createWorldCache();
  world.productionDiagnostics = createProductionDiagnosticsState(world.units);
};

function configureIsland(
  regions: MesoRegion[],
  regionIds: MesoRegionId[],
  portId: MesoRegionId,
  left: boolean,
): { regionIds: MesoRegionId[]; capitalId: MesoRegionId; portId: MesoRegionId; garrisonIds: MesoRegionId[] } {
  const byId = new Map(regions.map((region) => [region.id, region]));
  const ordered = regionIds.map((id) => byId.get(id)!).sort((a, b) =>
    (left ? a.center.x - b.center.x : b.center.x - a.center.x) || compareIds(a.id, b.id));
  const capital = ordered[0]!;
  const coastal = ordered.filter((region) => region.neighbors.some((neighbor) => byId.get(neighbor.id)?.type === "sea"));
  const secondaryPort = coastal.sort((a, b) =>
    distanceSquared(b, byId.get(portId)!) - distanceSquared(a, byId.get(portId)!) || compareIds(a.id, b.id))[0];
  const cities = [ordered[Math.floor(ordered.length / 3)]!, ordered[Math.floor(ordered.length * 2 / 3)]!]
    .filter((region, index, all) => region.id !== capital.id && region.id !== portId &&
      region.id !== secondaryPort?.id && all.findIndex((item) => item.id === region.id) === index);
  byId.get(portId)!.building = "port";
  if (secondaryPort && secondaryPort.id !== portId) secondaryPort.building = "port";
  capital.building = "capital";
  for (const city of cities) city.building = "city";
  const resourceSites = ordered.filter((region) => region.building === null).slice(0, 4);
  for (let index = 0; index < resourceSites.length; index += 1) {
    resourceSites[index]!.resource = index % 2 === 0 ? "steel" : "fuel";
  }
  return { regionIds, capitalId: capital.id, portId, garrisonIds: [capital.id, ...cities.map((city) => city.id)] };
}

function selectReachablePortPair(
  regions: MesoRegion[],
  left: MesoRegionId[],
  right: MesoRegionId[],
): [MesoRegionId, MesoRegionId] {
  const byId = new Map(regions.map((region) => [region.id, region]));
  const coastal = (ids: MesoRegionId[]) => ids.filter((id) =>
    byId.get(id)!.neighbors.some((neighbor) => byId.get(neighbor.id)?.type === "sea"));
  const candidates = coastal(left).flatMap((a) => coastal(right).map((b) => ({
    a, b, distance: Math.hypot(
      byId.get(a)!.center.x - byId.get(b)!.center.x,
      byId.get(a)!.center.y - byId.get(b)!.center.y,
    ),
  }))).sort((a, b) => a.distance - b.distance || compareIds(a.a, b.a) || compareIds(a.b, b.b));
  for (const candidate of candidates) {
    if (hasSeaRoute(byId, candidate.a, candidate.b)) return [candidate.a, candidate.b];
  }
  throw new Error("two-island-amphibious could not find mutually reachable ports");
}

function hasSeaRoute(byId: Map<MesoRegionId, MesoRegion>, start: MesoRegionId, end: MesoRegionId): boolean {
  const queue = [start];
  const visited = new Set<MesoRegionId>(queue);
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head]!;
    if (current === end) return true;
    for (const neighbor of byId.get(current)?.neighbors ?? []) {
      if (visited.has(neighbor.id)) continue;
      const region = byId.get(neighbor.id);
      if (!region || neighbor.id !== end && region.type !== "sea") continue;
      visited.add(neighbor.id);
      queue.push(neighbor.id);
    }
  }
  return false;
}

function largestComponent(
  regions: MesoRegion[],
  eligible: (region: MesoRegion) => boolean,
): MesoRegionId[] {
  const byId = new Map(regions.map((region) => [region.id, region]));
  const visited = new Set<MesoRegionId>();
  const components: MesoRegionId[][] = [];
  for (const region of regions) {
    if (!eligible(region) || visited.has(region.id)) continue;
    const component: MesoRegionId[] = [];
    const queue = [region.id];
    visited.add(region.id);
    for (let head = 0; head < queue.length; head += 1) {
      const id = queue[head]!;
      component.push(id);
      for (const neighbor of byId.get(id)?.neighbors ?? []) {
        const next = byId.get(neighbor.id);
        if (!next || visited.has(next.id) || !eligible(next)) continue;
        visited.add(next.id);
        queue.push(next.id);
      }
    }
    components.push(component);
  }
  return components.sort((a, b) => b.length - a.length || compareIds(a[0]!, b[0]!))[0] ?? [];
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function distanceSquared(a: MesoRegion, b: MesoRegion): number {
  return (a.center.x - b.center.x) ** 2 + (a.center.y - b.center.y) ** 2;
}
