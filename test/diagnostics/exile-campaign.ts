import assert from "node:assert/strict";
import { createExileWorld } from "../helpers/exile-world";
import { updateSurrender } from "../../src/sim/surrender";
import { allFieldUnits } from "../../src/sim/mobilization";
import { getOwnerByMesoId } from "../../src/sim/world-cache";
import { isNationActive, isNationPresent } from "../../src/sim/nation-active";
import { runSimulation } from "../helpers/simulation-driver";
import { withMutedSimulationLogs } from "../helpers/muted-logs";

const { world, a } = createExileWorld();
const homeland = new Set(world.macroRegions.flatMap((macro) => macro.mesoRegionIds));
updateSurrender(world); assert.equal(world.exileGovernments?.byNationId.get(a.id)?.status, "exiled");
let peakArmy = 0, restored = false, relocated = false;
const ticks = Number(process.argv[2] ?? 12000);
assert(Number.isSafeInteger(ticks) && ticks > 0);
withMutedSimulationLogs(() => {
  for (let part = 0; part < ticks; part += 100) {
    runSimulation(world, { ticks: Math.min(100, ticks - part) });
    const units = allFieldUnits(world);
    assert.equal(new Set(units.map((unit) => unit.id)).size, units.length);
    assert.equal(getOwnerByMesoId(world).size, homeland.size);
    const owners = new Set<string>();
    for (const macro of world.macroRegions) for (const id of macro.mesoRegionIds) { assert(!owners.has(id)); owners.add(id); }
    for (const nation of world.nations) {
      assert.deepEqual([...nation.macroRegionIds].sort(), world.macroRegions.filter((macro) => macro.nationId === nation.id).map((macro) => macro.id).sort());
      for (const amount of Object.values(nation.resources)) assert(Number.isFinite(amount) && amount >= -1e-8);
      const count = units.filter((unit) => unit.domain === "land" && unit.nationId === nation.id).length;
      assert(count <= 300); peakArmy = Math.max(peakArmy, count);
    }
    for (const faction of world.factions?.factions ?? []) {
      assert(faction.memberIds.includes(faction.leaderId));
      assert(world.nations.some((nation) => nation.id === faction.leaderId && isNationPresent(world, nation)));
      for (const id of faction.memberIds) assert(world.nations.some((nation) => nation.id === id && isNationPresent(world, nation)));
    }
    for (const record of world.exileGovernments?.byNationId.values() ?? []) {
      restored ||= record.status === "restored";
      if (record.status === "exiled") {
        assert(!world.nations.find((nation) => nation.id === record.nationId)!.macroRegionIds.length);
        assert(world.nations.some((nation) => nation.id === record.hostId && isNationActive(nation)));
      }
    }
    relocated ||= world.events?.some((event) => event.message.includes("relocated to")) ?? false;
  }
});
console.log(JSON.stringify({ ticks, status: world.exileGovernments?.byNationId.get(a.id)?.status, peakArmy, restored, relocated, governments: world.exileGovernments?.byNationId.size, invariants: "passed" }));
