import type { WorldState } from "../../world-state";
import type { UnitState } from "../../unit";
import type { MesoRegion, MesoRegionId } from "../../../worldgen/meso-region";
import type { NationId } from "../../../worldgen/nation";
import { buildWarAdjacency, isAtWar, type WarAdjacency } from "../../war-state";
import {
  getBorderTargetsByNation,
  getMesoById,
  getNeighborsById,
  getOwnerByMesoId,
} from "../../world-cache";
import { assignDefenseTargets, assignOccupationTargets } from "./target-assignment";
import {
  collectIntrusionTargetsByNation,
  collectLiberationTargetsByNation,
  collectOccupationTargetsByNation,
} from "./target-collectors";
import { moveUnitTowardTarget } from "./movement-engine";
import { isOwnedPassable, isPassableForNation, shouldUseWarPath } from "./passability";
import { clamp } from "./math";

export function repositionUnits(world: WorldState, dtMs: number): void {
  if (world.units.length === 0 || world.mesoRegions.length === 0) {
    return;
  }
  const landUnits = world.units.filter((unit) => unit.domain === "land");
  if (landUnits.length === 0) {
    return;
  }

  const mesoById = getMesoById(world);
  const neighborsById = getNeighborsById(world);
  const ownerByMesoId = getOwnerByMesoId(world);

  const warAdjacency = buildWarAdjacency(world.wars);
  const occupationByMesoId = world.occupation.mesoById;
  const hasEnemyUnits = (targetId: MesoRegionId, nationId: NationId): boolean => {
    for (const unit of landUnits) {
      if (
        unit.regionId === targetId &&
        unit.nationId !== nationId &&
        isAtWar(nationId, unit.nationId, warAdjacency)
      ) {
        return true;
      }
    }
    return false;
  };
  const liberationTargetsByNationId = collectLiberationTargetsByNation(
    occupationByMesoId,
    ownerByMesoId,
    mesoById,
  );
  const intrusionTargetsByNationId = collectIntrusionTargetsByNation(
    landUnits,
    ownerByMesoId,
    mesoById,
    warAdjacency,
  );
  const occupationTargetsByNationId = collectOccupationTargetsByNation(
    world.mesoRegions,
    ownerByMesoId,
    occupationByMesoId,
    warAdjacency,
  );
  const borderByNationId = getBorderTargetsByNation(world);

  const nationById = new Map<NationId, WorldState["nations"][number]>();
  for (const nation of world.nations) {
    nationById.set(nation.id, nation);
    nation.unitRoles.defenseUnitIds = [];
    nation.unitRoles.occupationUnitIds = [];
  }

  const unitsByNation = new Map<NationId, UnitState[]>();
  for (const unit of landUnits) {
    const list = unitsByNation.get(unit.nationId);
    if (list) {
      list.push(unit);
    } else {
      unitsByNation.set(unit.nationId, [unit]);
    }
  }

  for (const [nationId, units] of unitsByNation.entries()) {
    const borderTargets = borderByNationId.get(nationId) ?? [];
    const intrusionTargets = intrusionTargetsByNationId.get(nationId) ?? [];
    const liberationTargets = liberationTargetsByNationId.get(nationId) ?? [];
    const occupationTargets = occupationTargetsByNationId.get(nationId) ?? [];
    const orderedUnits = [...units].sort((a, b) => a.id.localeCompare(b.id));
    const defenseCount = determineDefenseUnitCount(
      orderedUnits.length,
      intrusionTargets.length,
      liberationTargets.length,
      occupationTargets.length,
    );
    const defenseUnits = orderedUnits.slice(0, defenseCount);
    const occupationUnits = orderedUnits.slice(defenseCount);
    const nation = nationById.get(nationId);
    if (nation) {
      nation.unitRoles.defenseUnitIds = defenseUnits.map((unit) => unit.id);
      nation.unitRoles.occupationUnitIds = occupationUnits.map((unit) => unit.id);
    }
    const isBlockedByEnemy = (toId: MesoRegionId): boolean =>
      hasEnemyUnits(toId, nationId);
    repositionNationUnits(
      nationId,
      defenseUnits,
      occupationUnits,
      intrusionTargets,
      liberationTargets,
      borderTargets,
      occupationTargets,
      dtMs,
      mesoById,
      neighborsById,
      ownerByMesoId,
      occupationByMesoId,
      warAdjacency,
      isBlockedByEnemy,
    );
  }
}

function repositionNationUnits(
  nationId: NationId,
  defenseUnits: UnitState[],
  occupationUnits: UnitState[],
  intrusionTargets: MesoRegionId[],
  liberationTargets: MesoRegionId[],
  borderTargets: MesoRegionId[],
  occupationTargets: MesoRegionId[],
  dtMs: number,
  mesoById: Map<MesoRegionId, MesoRegion>,
  neighborsById: Map<MesoRegionId, MesoRegionId[]>,
  ownerByMesoId: Map<MesoRegionId, NationId>,
  occupationByMesoId: Map<MesoRegionId, NationId>,
  warAdjacency: WarAdjacency,
  isBlockedByEnemy: (toId: MesoRegionId) => boolean,
): void {
  assignDefenseTargets(
    defenseUnits,
    nationId,
    intrusionTargets,
    liberationTargets,
    borderTargets,
    mesoById,
    neighborsById,
    ownerByMesoId,
    occupationByMesoId,
    warAdjacency,
  );
  assignOccupationTargets(
    occupationUnits,
    nationId,
    occupationTargets,
    mesoById,
    neighborsById,
    ownerByMesoId,
    warAdjacency,
  );

  const orderedUnits = [...defenseUnits, ...occupationUnits].sort((a, b) =>
    a.id.localeCompare(b.id),
  );

  for (const unit of orderedUnits) {
    const useWarPath = shouldUseWarPath(
      unit,
      nationId,
      ownerByMesoId,
      occupationByMesoId,
      mesoById,
      warAdjacency,
    );
    moveUnitTowardTarget(
      unit,
      dtMs,
      neighborsById,
      (id) =>
        useWarPath
          ? isPassableForNation(id, nationId, mesoById, ownerByMesoId, warAdjacency)
          : isOwnedPassable(id, nationId, mesoById, ownerByMesoId),
      isBlockedByEnemy,
    );
  }
}

function determineDefenseUnitCount(
  totalUnits: number,
  intrusionCount: number,
  liberationCount: number,
  occupationCount: number,
): number {
  if (totalUnits <= 0) {
    return 0;
  }
  let ratio = 0.4;
  if (intrusionCount > 0) {
    ratio = 0.7;
  } else if (liberationCount > 0) {
    ratio = 0.6;
  } else if (occupationCount > 0) {
    ratio = 0.4;
  } else {
    ratio = 1;
  }
  const minCount = intrusionCount > 0 || liberationCount > 0 || occupationCount > 0 ? 1 : 0;
  return clamp(Math.round(totalUnits * ratio), minCount, totalUnits);
}
