import { createWorldConfig } from "../../src/data/world-config";
import { createWorldFromMap } from "../../src/sim/create-world";
import { createMicroRegionEdges } from "../../src/worldgen/create-micro-region-edges";
import { createMacroRegionId, type MacroRegion } from "../../src/worldgen/macro-region";
import { createMesoRegionId, type MesoRegion } from "../../src/worldgen/meso-region";
import { createMicroRegionId, type MicroRegion } from "../../src/worldgen/micro-region";
import { createNationId, type Nation } from "../../src/worldgen/nation";

// Upper and lower pairs share land borders. All four countries have access to the same sea.
const LAND = [
  "............",
  ".AAAABBBB...",
  ".AAAABBBB...",
  ".AAAABBBB...",
  ".CCCCDDDD...",
  ".CCCCDDDD...",
  ".CCCCDDDD...",
  "............",
];
const CELL = 40;
const WIDTH = LAND[0].length;

export function fixedSocietyDistrict(x: number, y: number) {
  return createMesoRegionId(y * WIDTH + x);
}

export function createFixedSocietyWorld() {
  const config = createWorldConfig(WIDTH * CELL, LAND.length * CELL);
  config.systems = {};
  config.seed = 101;
  const microRegions: MicroRegion[] = [], mesoRegions: MesoRegion[] = [];
  const macroRegions: MacroRegion[] = [];
  const nations: Nation[] = [..."ABCD"].map((_, index) => ({
    id: createNationId(index), capitalMesoId: createMesoRegionId(-1), macroRegionIds: [],
  }));
  for (const [y, row] of LAND.entries()) for (const [x, marker] of [...row].entries()) {
    const index = y * WIDTH + x, isSea = marker === ".";
    const center = { x: (x + 0.5) * CELL, y: (y + 0.5) * CELL };
    const neighbors = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]
      .filter(([nx, ny]) => LAND[ny]?.[nx] !== undefined)
      .map(([nx, ny]) => ny * WIDTH + nx);
    const meso: MesoRegion = {
      id: createMesoRegionId(index), centerId: createMicroRegionId(index), center,
      type: isSea ? "sea" : "land", microRegionIds: [createMicroRegionId(index)],
      neighbors: neighbors.map((neighbor) => ({ id: createMesoRegionId(neighbor), hasRiver: false })),
      resource: null, building: null,
    };
    microRegions.push({
      id: meso.centerId, site: center,
      polygon: [[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1]].map(([px, py]) => ({ x: px * CELL, y: py * CELL })),
      neighbors: neighbors.map(createMicroRegionId), elevation: isSea ? 0 : 0.7,
      isSea, isRiver: false, mesoRegionId: meso.id,
    });
    mesoRegions.push(meso);
    if (isSea) continue;
    const nation = nations["ABCD".indexOf(marker)];
    const localX = (x - 1) % 4, localY = (y - 1) % 3;
    if (localX % 2 === 0) {
      const province = { id: createMacroRegionId(macroRegions.length), nationId: nation.id, mesoRegionIds: [meso.id], isCore: true };
      macroRegions.push(province);
      nation.macroRegionIds.push(province.id);
    } else macroRegions.at(-1)!.mesoRegionIds.push(meso.id);
    if (localX === 1 && localY === 1) {
      nation.capitalMesoId = meso.id;
      meso.building = "capital";
    } else if (localX === 0 && localY === 1) meso.building = "city";
    else if (localX === 0 && localY === 0) meso.building = "port";
    if (localX === 1 && localY === 0) meso.resource = "steel";
    if (localX === 2 && localY === 2) meso.resource = "fuel";
  }
  return createWorldFromMap(config, {
    microRegions, microRegionEdges: createMicroRegionEdges(microRegions), mesoRegions, macroRegions, nations,
  });
}
