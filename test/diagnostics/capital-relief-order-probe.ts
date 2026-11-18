import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { FrontlineDefensiveAssignment } from "../../src/sim/frontline-coverage";
import { getUnitCombatStrength } from "../../src/sim/unit-strength";
import type { UnitState } from "../../src/sim/unit";
import type { WarState } from "../../src/sim/war-state";
import type { WorldState } from "../../src/sim/world-state";
import type { MesoRegionId } from "../../src/worldgen/meso-region";
import { BenchmarkMetrics } from "../benchmark/metrics";

const decisionTick = 190;
const source = "meso-99" as MesoRegionId;
const unitId = "unit-53";

export function createReliefOrderProbe(
  world: WorldState, war: WarState, capital: MesoRegionId, intervene: boolean,
  remainsEligible: (unit: UnitState) => boolean,
) {
  const selected = world.units.find((candidate) => candidate.id === unitId);
  assert(selected && selected.nationId === war.defenderId && capital === "meso-72", "Different opening case");
  const unit = selected;
  const samples: object[] = [];
  let active = false;
  let priorAssignment: FrontlineDefensiveAssignment | undefined;
  let overrides = 0;
  let commonStateHash: string | null = null;
  let arrival: number | null = null;
  let releasedAt: number | null = null;

  function canOverride(): boolean {
    const assessment = world.capitalDefense.assessmentsByNationId.get(war.defenderId);
    return world.wars.includes(war) && world.units.includes(unit) && remainsEligible(unit) &&
      !!assessment && assessment.threatLevel !== "none" && assessment.capitalRegionId === capital &&
      !world.occupation.mesoById.has(capital) && world.macroRegions.some((macro) =>
        macro.nationId === war.defenderId && macro.mesoRegionIds.includes(capital));
  }

  class ProbeMetrics extends BenchmarkMetrics {
    override incrementCounter(name: string, amount = 1) {
      super.incrementCounter(name, amount);
      if (name !== "target.reassignments" || !active || !canOverride()) return;
      const liveAssignments = world.frontlineCoverage.assignmentByUnitId;
      const assignment = liveAssignments.get(unit.id);
      if (!assignment) return;
      // Only the normal movement builder sees the alternative destination.
      priorAssignment = assignment;
      liveAssignments.set(unit.id, { ...assignment, targetRegionId: capital });
      overrides++;
    }

    override recordDuration(name: string, ms: number) {
      if (name === "assignment.rebuild" && priorAssignment) {
        world.frontlineCoverage.assignmentByUnitId.set(unit.id, priorAssignment);
        priorAssignment = undefined;
      }
      super.recordDuration(name, ms);
    }
  }

  return {
    metrics: new ProbeMetrics(),
    observe() {
      const tick = world.time.fastTick;
      if (tick < decisionTick || (samples.length && !world.wars.includes(war))) return;
      if (tick === decisionTick) {
        assert.equal(unit.regionId, source);
        assert.equal(unit.moveTargetId, source);
        assert.equal(world.frontlineCoverage.assignmentByUnitId.get(unit.id)?.targetRegionId, source);
        assert(canOverride(), "Different decision-state eligibility");
        commonStateHash = createHash("sha256").update(JSON.stringify({
          units: world.units, wars: world.wars, nations: world.nations, macroRegions: world.macroRegions,
          occupation: world.occupation, assignments: [...world.frontlineCoverage.assignmentByUnitId],
        }, (_key, item) => item instanceof Map ? [...item] : item instanceof Set ? [...item] : item)).digest("hex");
        active = intervene;
        if (active) unit.moveTargetId = null; // Invalidate the warmed assignment once.
      } else if (active && (!canOverride() || !world.frontlineCoverage.assignmentByUnitId.has(unit.id))) {
        active = false;
        releasedAt = tick;
        if (unit.moveTargetId === capital) unit.moveTargetId = null;
      }
      if (world.units.includes(unit) && unit.regionId === capital) arrival ??= tick;
      const sourceUnits = world.units.filter((other) =>
        other.domain === "land" && other.nationId === war.defenderId && other.regionId === source);
      const post = world.frontlineCoverage.coverages.filter((item) => item.nationId === war.defenderId)
        .flatMap((item) => item.positions).find((item) => item.friendlyRegionId === source);
      samples.push({
        tick, active, regionId: world.units.includes(unit) ? unit.regionId : null,
        target: tick === decisionTick ? source : unit.moveTargetId, organization: unit.org,
        sourceHeldBy: world.occupation.mesoById.get(source) ?? world.macroRegions.find((macro) =>
          macro.mesoRegionIds.includes(source))?.nationId ?? null,
        sourceStrength: sourceUnits.reduce((total, other) => total + getUnitCombatStrength(other), 0),
        sourceOtherStrength: sourceUnits.filter((other) => other !== unit)
          .reduce((total, other) => total + getUnitCombatStrength(other), 0),
        sourcePostRequired: post?.requiredStrength ?? null,
        sourceBattle: world.battles.some((battle) => battle.mesoId === source),
      });
    },
    result() {
      assert(commonStateHash, "The selected decision was not reached");
      if (intervene) assert(overrides > 0, "The normal movement builder did not consume the override");
      return { intervene, decisionTick, unitId, source, commonStateHash, arrival, releasedAt, overrides, samples };
    },
  };
}
