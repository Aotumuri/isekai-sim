import { WORLD_BALANCE } from "../../src/data/balance";
import { updateCapitalDefense } from "../../src/sim/capital-defense";
import { createUnitForType } from "../../src/sim/create-units";
import { updateLandFronts } from "../../src/sim/land-fronts";
import { updateNationFrontAllocations } from "../../src/sim/nation-front-allocations";
import { updateNationFrontPlans } from "../../src/sim/nation-front-plans";
import { updateReorganization } from "../../src/sim/reorganization";
import { updateRetreatPlans } from "../../src/sim/retreat-plans";
import { updateStrategicReserves } from "../../src/sim/strategic-reserves";
import { createUnitId } from "../../src/sim/unit";
import { declareWar } from "../../src/sim/war-state";
import type { WorldState } from "../../src/sim/world-state";
import type { MesoRegionId } from "../../src/worldgen/meso-region";
import type { NationId } from "../../src/worldgen/nation";
import { buildOwnerByMesoId } from "./scenario-utils";
import type { ScenarioSetup } from "./types";

interface RearPair {
  recoveringNationId: NationId;
  enemyNationId: NationId;
  friendlyFrontRegionId: MesoRegionId;
  enemyFrontRegionId: MesoRegionId;
  rearRegionId: MesoRegionId;
  rearDepth: number;
}

export const setupReorganizationHeavy: ScenarioSetup = (world, options) => {
  const selected = selectDeepestAdjacentPair(world);
  if (!selected || selected.rearDepth < 2) {
    throw new Error("reorganization-heavy requires a two-region rear area");
  }
  world.wars = [];
  if (
    !declareWar(
      world.wars,
      selected.recoveringNationId,
      selected.enemyNationId,
      world.time.fastTick,
      true,
    )
  ) {
    throw new Error("reorganization-heavy war could not be created");
  }

  const rear = world.mesoRegions.find(
    (region) => region.id === selected.rearRegionId,
  );
  if (rear && rear.building !== "capital") {
    rear.building = "city";
    world.buildingVersion += 1;
  }

  world.units = world.units.filter(
    (unit) =>
      unit.nationId !== selected.recoveringNationId &&
      unit.nationId !== selected.enemyNationId,
  );
  addForce(
    world,
    selected.recoveringNationId,
    selected.friendlyFrontRegionId,
    options.quick ? 8 : 16,
    false,
  );
  addForce(
    world,
    selected.recoveringNationId,
    selected.friendlyFrontRegionId,
    options.quick ? 6 : 12,
    true,
  );
  addForce(
    world,
    selected.enemyNationId,
    selected.enemyFrontRegionId,
    options.quick ? 10 : 20,
    false,
  );

  const recoveringNation = world.nations.find(
    (nation) => nation.id === selected.recoveringNationId,
  );
  if (recoveringNation) {
    recoveringNation.resources.manpower = Math.max(
      recoveringNation.resources.manpower,
      options.quick ? 4_000 : 8_000,
    );
    recoveringNation.resources.weapons = Math.max(
      recoveringNation.resources.weapons,
      options.quick ? 80 : 160,
    );
  }

  updateLandFronts(world);
  updateCapitalDefense(world);
  updateNationFrontPlans(world);
  updateRetreatPlans(world);
  updateNationFrontAllocations(world);
  updateStrategicReserves(world);
  updateNationFrontAllocations(world);
  updateReorganization(world);
  updateNationFrontAllocations(world);
};

function addForce(
  world: WorldState,
  nationId: NationId,
  regionId: MesoRegionId,
  count: number,
  damaged: boolean,
): void {
  for (let index = 0; index < count; index += 1) {
    const type = index % 5 === 0 ? "Tank" : "Infantry";
    const unit = createUnitForType(
      createUnitId(world.unitIdCounter),
      nationId,
      regionId,
      type,
    );
    world.unitIdCounter += 1;
    if (damaged) {
      unit.org = 0.24 + (index % 3) * 0.03;
      unit.manpower = WORLD_BALANCE.unit.types[type].manpower * 0.48;
      for (const slot of unit.equipment) slot.fill *= 0.45;
    }
    world.units.push(unit);
  }
}

function selectDeepestAdjacentPair(world: WorldState): RearPair | null {
  const ownerByRegionId = buildOwnerByMesoId(world);
  const mesoById = new Map(world.mesoRegions.map((region) => [region.id, region]));
  const contacts = new Map<
    string,
    {
      nationAId: NationId;
      nationBId: NationId;
      borderA: Set<MesoRegionId>;
      borderB: Set<MesoRegionId>;
    }
  >();
  for (const region of world.mesoRegions) {
    if (region.type === "sea") continue;
    const owner = ownerByRegionId.get(region.id);
    if (!owner) continue;
    for (const neighbor of region.neighbors) {
      const other = ownerByRegionId.get(neighbor.id);
      if (!other || other === owner || mesoById.get(neighbor.id)?.type === "sea") {
        continue;
      }
      const [nationAId, nationBId] = owner < other ? [owner, other] : [other, owner];
      const key = `${nationAId}:${nationBId}`;
      let contact = contacts.get(key);
      if (!contact) {
        contact = {
          nationAId,
          nationBId,
          borderA: new Set(),
          borderB: new Set(),
        };
        contacts.set(key, contact);
      }
      if (owner === nationAId) {
        contact.borderA.add(region.id);
        contact.borderB.add(neighbor.id);
      } else {
        contact.borderB.add(region.id);
        contact.borderA.add(neighbor.id);
      }
    }
  }

  const candidates: RearPair[] = [];
  for (const contact of contacts.values()) {
    const a = deepestOwnedRegion(
      world,
      contact.nationAId,
      contact.borderA,
      ownerByRegionId,
    );
    const b = deepestOwnedRegion(
      world,
      contact.nationBId,
      contact.borderB,
      ownerByRegionId,
    );
    if (a) {
      candidates.push({
        recoveringNationId: contact.nationAId,
        enemyNationId: contact.nationBId,
        friendlyFrontRegionId: [...contact.borderA].sort()[0],
        enemyFrontRegionId: [...contact.borderB].sort()[0],
        rearRegionId: a.regionId,
        rearDepth: a.depth,
      });
    }
    if (b) {
      candidates.push({
        recoveringNationId: contact.nationBId,
        enemyNationId: contact.nationAId,
        friendlyFrontRegionId: [...contact.borderB].sort()[0],
        enemyFrontRegionId: [...contact.borderA].sort()[0],
        rearRegionId: b.regionId,
        rearDepth: b.depth,
      });
    }
  }
  return candidates.sort(
    (a, b) =>
      b.rearDepth - a.rearDepth ||
      `${a.recoveringNationId}:${a.enemyNationId}`.localeCompare(
        `${b.recoveringNationId}:${b.enemyNationId}`,
      ),
  )[0] ?? null;
}

function deepestOwnedRegion(
  world: WorldState,
  nationId: NationId,
  sources: ReadonlySet<MesoRegionId>,
  ownerByRegionId: Map<MesoRegionId, NationId>,
): { regionId: MesoRegionId; depth: number } | null {
  const mesoById = new Map(world.mesoRegions.map((region) => [region.id, region]));
  const distances = new Map<MesoRegionId, number>();
  const queue = [...sources].sort();
  for (const source of queue) distances.set(source, 0);
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    const distance = distances.get(current) ?? 0;
    for (const neighbor of mesoById.get(current)?.neighbors ?? []) {
      if (
        distances.has(neighbor.id) ||
        ownerByRegionId.get(neighbor.id) !== nationId ||
        mesoById.get(neighbor.id)?.type === "sea"
      ) {
        continue;
      }
      distances.set(neighbor.id, distance + 1);
      queue.push(neighbor.id);
    }
  }
  return [...distances.entries()]
    .map(([regionId, depth]) => ({ regionId, depth }))
    .sort(
      (a, b) => b.depth - a.depth || a.regionId.localeCompare(b.regionId),
    )[0] ?? null;
}
