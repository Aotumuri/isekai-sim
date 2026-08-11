import { Container, Graphics, Text, TextStyle } from "pixi.js";
import { WORLD_BALANCE } from "../data/balance";
import type {
  FrontBorderEdge,
  OperationalSector,
  PhysicalFront,
  SectorId,
} from "../sim/land-fronts";
import { getFrontPlan, getStrengthRatio } from "../sim/nation-front-plans";
import {
  getOffensiveOperationForFront,
  getOperationCandidateForFront,
} from "../sim/offensive-operations";
import { getRetreatPlanForFront } from "../sim/retreat-plans";
import type { UnitId } from "../sim/unit";
import { getUnitCombatStrength } from "../sim/unit-strength";
import type { WorldState } from "../sim/world-state";
import type { MesoRegionId } from "../worldgen/meso-region";
import type { MicroRegion } from "../worldgen/micro-region";
import type { NationId } from "../worldgen/nation";
import { getFrontlineCoverage } from "../sim/frontline-coverage";
import { getFrontAllocation } from "../sim/nation-front-allocations";
import { getStalemateAssessment } from "../sim/stalemate-pressure";
import { getStrategicProgressAssessment } from "../sim/strategic-progress";
import { getBattlefieldTopologyAssessment } from "../sim/battlefield-topology";
import { getNationSupplyAssessment } from "../sim/supply-assessment";
import { getUnitIsolationEffect } from "../sim/isolation-effects";
import {
  getUnitEquipmentFulfillment,
  getUnitManpowerRatio,
} from "../sim/reorganization";
import type { Vec2 } from "../utils/vector";
import { clearLayer } from "./clear-layer";
import { findSharedSegments, type Segment } from "./meso-border-geometry";
import { getMicroRegionByIdMap } from "./region-index";
import type { Renderer } from "./renderer";
import { getMaritimeLinkProtection } from "../sim/maritime-escort";
import type { StrategicNationObservation } from "../sim/strategic-threat-observation";
import { getAmphibiousOperationValidation } from "../sim/amphibious";

/** Change this one value to change the development overlay's initial state. */
export const DEFAULT_FRONT_DEBUG_OVERLAY = true;
export const FRONT_DEBUG_OVERLAY_SHORTCUT = "KeyF";

const FRONT_COLORS = [
  0x00e5ff, 0xffd740, 0xff5c8a, 0x69f0ae, 0xb388ff, 0xff8a65,
  0x40c4ff, 0xeeff41, 0xf06292, 0x7cfc00, 0x82b1ff, 0xffab40,
];
const FONT_FAMILY = "Fira Sans, Noto Sans, Helvetica Neue, Helvetica, Arial, sans-serif";
const LABEL_STYLE = new TextStyle({
  fontFamily: FONT_FAMILY,
  fontSize: 10,
  lineHeight: 12,
  fill: 0xf4f7fb,
});
const MARKER_STYLE = new TextStyle({
  fontFamily: FONT_FAMILY,
  fontSize: 9,
  fontWeight: "bold",
  fill: 0xffffff,
  stroke: 0x000000,
  strokeThickness: 3,
});

interface OverlayVersions {
  fronts: number;
  frontMetrics: number;
  plans: number;
  operations: number;
  collapseAdvances: number;
  battlefieldTopology: number;
  supplyAssessment: number;
  maritimeInterdiction: number;
  navalStrategy: number;
  amphibiousOperations: number;
  convoys: number;
  isolationEffects: number;
  productionDiagnostics: number;
  supplyCutoffs: number;
  supplyDefense: number;
  supplyRelief: number;
  retreats: number;
  coverage: number;
  stalemate: number;
  strategicThreat: number;
  coalitions: number;
  reserveDeployments: string;
  battles: string;
}

interface LabelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FrontDebugOverlay {
  update: () => void;
  toggle: () => void;
  setEnabled: (enabled: boolean) => void;
  isEnabled: () => boolean;
}

export function attachFrontDebugOverlay(
  renderer: Renderer,
  world: WorldState,
): FrontDebugOverlay {
  const layer = renderer.worldLayers.layers.FrontDebug;
  const borderSegments = indexMesoBorderSegments(world.microRegions);
  let enabled = DEFAULT_FRONT_DEBUG_OVERLAY;
  let selectedSectorId: SectorId | null = null;
  let pointerDownPosition: Vec2 | null = null;
  let pointerMoved = false;
  let versions: OverlayVersions | null = null;

  const draw = (): void => {
    clearLayer(layer);
    if (!enabled) {
      return;
    }

    world.landFronts.physicalFronts.forEach((front) => {
      drawPhysicalFrontBoundary(layer, world, front, borderSegments);
    });
    const unitById = new Map(world.units.map((unit) => [unit.id, unit]));
    world.landFronts.operationalSectors.forEach((sector, index) => {
      const color = FRONT_COLORS[index % FRONT_COLORS.length];
      const label = createSectorLabel(
        world,
        sector,
        color,
        unitById,
        sector.id === selectedSectorId,
      );
      label.visible = sector.id === selectedSectorId;
      drawSector(layer, world, sector, color, borderSegments, {
        showLabel: () => {
          label.visible = true;
        },
        hideLabel: () => {
          label.visible = selectedSectorId === sector.id;
        },
      });
      placeLabel(label, getFrontAnchor(sector, world), index, [], world.width, world.height);
      layer.addChild(label);
    });
    drawSupplySourceMarkers(layer, world);
    drawSupplyCutoffMarkers(layer, world);
    drawSupplyDefenseMarkers(layer, world);
    drawSupplyReliefMarkers(layer, world);
    drawMaritimeSupplyLinks(layer, world);
    drawNavalMissions(layer, world);
    drawAmphibiousOperations(layer, world);
    drawStrategicThreatSummary(layer, world);
    if (selectedSectorId && !world.landFronts.operationalSectorsById.has(selectedSectorId)) {
      selectedSectorId = null;
    }
  };

  const update = (): void => {
    if (!enabled) {
      return;
    }
    const next = readVersions(world);
    if (versions && versionsEqual(versions, next)) {
      return;
    }
    versions = next;
    draw();
  };

  const setEnabled = (next: boolean): void => {
    if (enabled === next) {
      return;
    }
    enabled = next;
    layer.visible = enabled;
    if (enabled) {
      versions = null;
      update();
    } else {
      selectedSectorId = null;
      clearLayer(layer);
    }
  };

  const toggle = (): void => setEnabled(!enabled);

  window.addEventListener("keydown", (event) => {
    if (event.code !== FRONT_DEBUG_OVERLAY_SHORTCUT || event.repeat || isEditableTarget(event.target)) {
      return;
    }
    toggle();
    event.preventDefault();
  });

  renderer.app.stage.on("pointerdown", (event) => {
    pointerDownPosition = { x: event.global.x, y: event.global.y };
    pointerMoved = false;
  });
  renderer.app.stage.on("pointermove", (event) => {
    if (!pointerDownPosition) return;
    const dx = event.global.x - pointerDownPosition.x;
    const dy = event.global.y - pointerDownPosition.y;
    if (dx * dx + dy * dy > 16) {
      pointerMoved = true;
    }
  });
  renderer.app.stage.on("pointerupoutside", () => {
    pointerDownPosition = null;
    pointerMoved = false;
  });
  renderer.app.stage.on("pointertap", (event) => {
    pointerDownPosition = null;
    if (pointerMoved) {
      pointerMoved = false;
      return;
    }
    if (!enabled) {
      return;
    }
    const worldPoint = renderer.worldContainer.toLocal(event.global);
    const clickedSectorId = getSectorIdFromTarget(event.target) ?? findSectorAtPoint(
      world,
      worldPoint,
      borderSegments,
      10 / renderer.worldContainer.scale.x,
    );
    const nextSelection =
      clickedSectorId &&
      clickedSectorId !== selectedSectorId &&
      world.landFronts.operationalSectorsById.has(clickedSectorId)
        ? clickedSectorId
        : null;
    if (selectedSectorId === nextSelection) {
      return;
    }
    selectedSectorId = nextSelection;
    versions = null;
    update();
  });

  layer.visible = enabled;
  update();
  return { update, toggle, setEnabled, isEnabled: () => enabled };
}

function drawPhysicalFrontBoundary(
  layer: Container,
  world: WorldState,
  front: PhysicalFront,
  borderSegments: ReadonlyMap<string, readonly Segment[]>,
): void {
  const geometry = new Graphics();
  geometry.name = `PhysicalFrontDebugGeometry:${front.id}`;
  geometry.lineStyle({ width: 9, color: 0x03070c, alpha: 0.9, cap: "round", join: "round" });
  drawBorderEdges(geometry, front.borderEdges, borderSegments, world);
  geometry.lineStyle({ width: 7, color: 0xffffff, alpha: 0.36, cap: "round", join: "round" });
  drawBorderEdges(geometry, front.borderEdges, borderSegments, world);
  layer.addChild(geometry);
}

function drawSector(
  layer: Container,
  world: WorldState,
  sector: OperationalSector,
  color: number,
  borderSegments: ReadonlyMap<string, readonly Segment[]>,
  labelEvents: { showLabel: () => void; hideLabel: () => void },
): void {
  const geometry = new Graphics();
  geometry.name = `SectorDebugGeometry:${sector.id}`;
  geometry.eventMode = "static";
  geometry.cursor = "pointer";
  geometry.on("pointerover", labelEvents.showLabel);
  geometry.on("pointerout", labelEvents.hideLabel);
  geometry.lineStyle({ width: 14, color: 0xffffff, alpha: 0.001, cap: "round", join: "round" });
  drawBorderEdges(geometry, sector.frontline.borderEdges, borderSegments, world);
  geometry.lineStyle({ width: 4, color, alpha: 0.98, cap: "round", join: "round" });
  drawBorderEdges(geometry, sector.frontline.borderEdges, borderSegments, world);
  layer.addChild(geometry);
  drawFrontMarkers(layer, world, sector, color);
}

function drawBorderEdges(
  graphics: Graphics,
  edges: readonly FrontBorderEdge[],
  segmentIndex: ReadonlyMap<string, readonly Segment[]>,
  world: WorldState,
): void {
  for (const edge of edges) {
    const segments = segmentIndex.get(mesoPairKey(edge.regionAId, edge.regionBId));
    if (segments && segments.length > 0) {
      for (const segment of segments) {
        graphics.moveTo(segment.a.x, segment.a.y);
        graphics.lineTo(segment.b.x, segment.b.y);
      }
      continue;
    }
    const a = world.cache.mesoById.get(edge.regionAId)?.center;
    const b = world.cache.mesoById.get(edge.regionBId)?.center;
    if (a && b) {
      graphics.moveTo(a.x, a.y);
      graphics.lineTo(b.x, b.y);
    }
  }
}

function createSectorLabel(
  world: WorldState,
  front: OperationalSector,
  color: number,
  unitById: ReadonlyMap<UnitId, WorldState["units"][number]>,
  selected: boolean,
): Container {
  const container = new Container();
  container.name = `SectorDebugLabel:${front.id}`;
  container.eventMode = "none";
  const text = new Text(formatSectorLabel(world, front, unitById, selected), LABEL_STYLE);
  text.resolution = 2;
  const bounds = text.getLocalBounds();
  const padding = 5;
  const background = new Graphics();
  background.beginFill(0x081018, 0.88);
  background.lineStyle(1.5, color, 0.95);
  background.drawRoundedRect(0, 0, bounds.width + padding * 2, bounds.height + padding * 2, 4);
  background.endFill();
  text.position.set(padding, padding);
  container.addChild(background, text);
  return container;
}

export function formatFrontLabel(
  world: WorldState,
  front: PhysicalFront,
  unitById: ReadonlyMap<UnitId, WorldState["units"][number]> = new Map(
    world.units.map((unit) => [unit.id, unit]),
  ),
): string {
  const lines = [
    `FRONT ${front.id}`,
    `extent ${front.borderLength} edges | ${front.sideA.borderRegionIds.length}+${front.sideB.borderRegionIds.length} regions`,
    ...formatNationSide(world, front, front.nationAId),
    ...formatNationSide(world, front, front.nationBId),
  ];

  for (const nationId of [front.nationAId, front.nationBId]) {
    const operation = getOffensiveOperationForFront(world, front.id, nationId);
    if (operation) {
      const targets = [operation.primaryTargetRegionId, ...operation.supportingTargetRegionIds];
      lines.push(
        `OP ${nationId} ${operation.phase.toUpperCase()} ${operation.id}`,
        `  targets ${targets.join(", ")}`,
      );
      if (operation.exploitationStartedAtTick !== null) {
        const startedAt = world.instrumentation ? performance.now() : 0;
        lines.push(
          `  E target ${operation.exploitationTargetRegionId ?? "none"} | depth ${operation.exploitationDepth}`,
          `  force ${operation.exploitationUnitIds.length}/${operation.assignedUnitIds.length} units (${formatStrength(operation.exploitationForceStrength)})`,
          `  ${operation.exploitationTargetCoverageState ?? "none"} | local ${formatStrength(operation.exploitationTargetLocalEnemyStrength)} | ratio ${formatRatio(getStrengthRatio(operation.exploitationForceStrength, operation.exploitationTargetLocalEnemyStrength))} | score ${operation.exploitationTargetScore.toFixed(1)}`,
          `  stop ${operation.exploitationStopReason ?? "none"}`,
        );
        world.instrumentation?.recordDuration(
          "debugOverlay.exploitation",
          performance.now() - startedAt,
        );
      }
    }
    const retreat = getRetreatPlanForFront(world, front.id, nationId);
    if (retreat) {
      lines.push(
        `RET ${nationId} ${retreat.phase.toUpperCase()} ${retreat.id}`,
        `  fallback ${retreat.fallbackRegionIds.join(", ")} | remaining ${retreat.retreatingUnitIds.length}`,
      );
    }
  }

  for (const reserve of world.strategicReserves.reserves) {
    const deployment = reserve.deployment;
    if (!deployment || deployment.status === "returning" || deployment.targetFrontId !== front.id) {
      continue;
    }
    const strength = deployment.unitIds.reduce((sum, unitId) => {
      const unit = unitById.get(unitId);
      return sum + (unit ? getUnitCombatStrength(unit) : 0);
    }, 0);
    lines.push(
      `RES ${reserve.nationId} ${formatStrength(strength)} | ${deployment.unitIds.length} units`,
    );
  }

  return lines.join("\n");
}

export function formatSectorLabel(
  world: WorldState,
  sector: OperationalSector,
  unitById: ReadonlyMap<UnitId, WorldState["units"][number]> = new Map(
    world.units.map((unit) => [unit.id, unit]),
  ),
  selected = false,
): string {
  const lines = [
    `SECTOR ${sector.id}`,
    `front ${sector.physicalFrontId} | frontline ${sector.borderLength} edges`,
    ...formatNationSide(world, sector, sector.nationAId),
    ...formatNationSide(world, sector, sector.nationBId),
  ];
  if (selected) {
    lines.push(`cells ${sector.frontline.sideARegionIds.length}+${sector.frontline.sideBRegionIds.length}`);
    for (const nationId of [sector.nationAId, sector.nationBId]) {
      const coverage = getFrontlineCoverage(world, sector.id, nationId);
      if (!coverage) continue;
      lines.push(
        `LINE ${nationId} ${coverage.coveredSegments}/${coverage.weakSegments}/${coverage.gapSegments} covered/weak/gap | ${(coverage.coverageRatio * 100).toFixed(0)}%`,
        `  defense ${formatStrength(coverage.defenderStrength)} / ${formatStrength(coverage.minimumRequiredStrength)} | surplus ${formatStrength(coverage.offensiveSurplusStrength)}`,
        `  max gap ${coverage.maxGapLength} | breakthroughs ${coverage.breakthroughCount}`,
      );
    }
  }
  appendOperationalDetails(lines, world, sector, unitById, selected);
  return lines.join("\n");
}

function appendOperationalDetails(
  lines: string[],
  world: WorldState,
  front: OperationalSector,
  unitById: ReadonlyMap<UnitId, WorldState["units"][number]>,
  selected = false,
): void {
  for (const nationId of [front.nationAId, front.nationBId]) {
    const operation = getOffensiveOperationForFront(world, front.id, nationId);
    const candidate = getOperationCandidateForFront(world, front.id, nationId);
    if (selected) {
      const supply = getNationSupplyAssessment(world, nationId);
      if (supply) {
        lines.push(
          `SUPPLY ${nationId}`,
          `  sources ${supply.supplySourceRegionIds.join(", ") || "none"}`,
          `  supplied ${supply.suppliedComponentCount} | isolated ${supply.isolatedComponentCount}`,
        );
        for (const component of supply.components) {
          const isolationAge = component.isolatedSinceTick === null
            ? 0
            : Math.max(0, world.time.fastTick - component.isolatedSinceTick);
          const isolationStage = component.supplied
            ? "SUPPLIED"
            : isolationAge > WORLD_BALANCE.war.landFront.isolation.graceTicks
              ? "STRAINED"
              : "ISOLATED";
          const reconnectDuration = component.reconnectedTick === null
            ? 0
            : world.time.fastTick - component.reconnectedTick;
          lines.push(
            `  component ${component.id} [${component.topologyComponentId}] ${component.supplied ? "SUPPLIED" : "ISOLATED"}`,
            `    isolation age ${isolationAge} | state ${isolationStage} | reconnect ${reconnectDuration}`,
            `    passive decay ${component.supplied ? "OFF" : isolationStage === "STRAINED" ? "ACTIVE" : "OFF"} | ${component.reason}`,
          );
        }
        const isolationSettings = WORLD_BALANCE.war.landFront.isolation;
        for (const unit of [...unitById.values()]
          .filter((candidate) =>
            candidate.nationId === nationId && candidate.domain === "land"
          )
          .filter((candidate) =>
            getUnitIsolationEffect(world, candidate).stage !== "supplied"
          )
          .slice(0, 6)) {
          const effect = getUnitIsolationEffect(world, unit);
          lines.push(
            `ISOLATION ${unit.id} | ${effect.stage.toUpperCase()}`,
            `  isolation age ${effect.age} ticks | passive decay ${effect.decayActive ? "ACTIVE" : "OFF"}`,
            `  organization ${unit.org.toFixed(3)} | decay/tick -${isolationSettings.organizationDecayPerSlowTick.toFixed(4)} | floor ${isolationSettings.organizationFloor.toFixed(2)}`,
            "  recovery BLOCKED",
          );
        }
        for (const diagnostic of [...world.productionDiagnostics.locationByRegionId.values()]
          .filter((candidate) => candidate.nationId === nationId)
          .slice(0, 8)) {
          lines.push(
            `PRODUCTION ${diagnostic.regionId}`,
            diagnostic.supplyStatus === "supplied"
              ? "  SUPPLIED"
              : "  BLOCKED (Isolation)",
            `  component ${diagnostic.componentId ?? "none"}`,
          );
        }
      }
      const reorganizationPlans = (
        world.reorganization.plansByNationId.get(nationId) ?? []
      ).slice(0, 4);
      for (const plan of reorganizationPlans) {
        const unit = unitById.get(plan.unitId);
        const liveIsolationDuration = plan.isolatedDurationTicks +
          (plan.supplyStatus === "isolated" && plan.lastSupplyEvaluationTick !== null
            ? Math.max(0, world.time.fastTick - plan.lastSupplyEvaluationTick)
            : 0);
        const readySettings = WORLD_BALANCE.war.landFront.reorganization;
        const organizationReady = !!unit &&
          unit.org >= readySettings.readyOrganizationRatio;
        const ready = organizationReady && !!unit &&
          getUnitManpowerRatio(unit) >= readySettings.readyManpowerRatio &&
          getUnitEquipmentFulfillment(unit) >= readySettings.readyEquipmentRatio;
        const readyReason = organizationReady ? "readiness" : "organization";
        lines.push(
          `REORGANIZATION ${plan.unitId} | ${plan.phase.toUpperCase()}`,
          `  SUPPLY ${(plan.supplyStatus ?? "not-evaluated").toUpperCase()} | isolated ${liveIsolationDuration} ticks`,
          `  org ${((unit?.org ?? 0) * 100).toFixed(0)}% | recovery ${plan.supplyStatus === "isolated" ? "BLOCKED" : "ACTIVE"}`,
          `  org denied +${plan.organizationDeniedByIsolation.toFixed(3)}`,
          `  manpower ${((unit ? getUnitManpowerRatio(unit) : 0) * 100).toFixed(0)}% -> ${plan.supplyStatus === "isolated" ? "BLOCKED" : "reinforcing"}`,
          `  equipment ${((unit ? getUnitEquipmentFulfillment(unit) : 0) * 100).toFixed(0)}% -> ${plan.supplyStatus === "isolated" ? "BLOCKED" : "reinforcing"}`,
          `  denied manpower ${plan.manpowerDeniedByIsolation.toFixed(1)} | weapons ${plan.equipmentDeniedByIsolation.toFixed(2)}`,
          `  READY ${ready ? "YES" : `NO — ${readyReason} below threshold`}`,
          `  stocks manpower ${plan.lastManpowerStockBefore.toFixed(1)} -> ${plan.lastManpowerStockAfter.toFixed(1)} | weapons ${plan.lastWeaponsStockBefore.toFixed(2)} -> ${plan.lastWeaponsStockAfter.toFixed(2)}`,
        );
      }
      const enemyId = nationId === front.nationAId ? front.nationBId : front.nationAId;
      const topology = getBattlefieldTopologyAssessment(world, nationId, enemyId);
      const enemyInfluence = nationId === front.nationAId ? front.sideB.influenceRegionIds : front.sideA.influenceRegionIds;
      const pockets = world.battlefieldTopology.pockets.filter((pocket) =>
        pocket.attackerNationId === nationId && pocket.enemyNationId === enemyId &&
        pocket.boundaryRegionIds.some((regionId) => enemyInfluence.includes(regionId))
      );
      const collapseOpportunity = topology?.collapseOpportunities.find((item) => item.sectorId === front.id);
      const component = collapseOpportunity
        ? topology?.enemyComponents.find((item) => item.id === collapseOpportunity.componentId)
        : topology?.enemyComponents.find((item) => item.regionIds.some((id) => enemyInfluence.includes(id)));
      const corridor = component ? topology?.escapeCorridors.find((item) => item.componentId === component.id) : undefined;
      const articulation = corridor ? topology?.articulationRegions.find((item) => item.regionId === corridor.regionId) : undefined;
      if (component) {
        lines.push(
          `TOPOLOGY ${nationId} -> ${enemyId}`,
          `  component ${component.id} | regions ${component.regionCount} | strength ${formatStrength(component.enemyStrength)}`,
          `  front contacts ${component.frontlineContactCount} | rear exits ${collapseOpportunity?.exitCount ?? component.exitCount}`,
          `COLLAPSE ${collapseOpportunity ? collapseOpportunity.score.toFixed(0) : "none"} | ${collapseOpportunity?.reasonFlags[0] ?? "coherent-front"}`,
          `  reasons ${collapseOpportunity?.reasonFlags.join(", ") || "none"}`,
          ...(articulation ? [
            `  articulation ${articulation.regionId} | affected ${articulation.affectedRegionCount} regions`,
            `  affected strength ${formatStrength(articulation.enemyStrengthAffected)} | cities ${articulation.citiesAffected}`,
          ] : []),
        );
      }
      for (const cutoff of world.supplyCutoffs.candidates
        .filter((item) => item.attackerNationId === nationId && item.sectorId === front.id)
        .slice(0, 4)) {
        lines.push(
          `SUPPLY CUTOFF ${cutoff.targetRegionId} | ${cutoff.tacticalFeasibility ? "FEASIBLE" : "BLOCKED"}`,
          `  predicted ${formatStrength(cutoff.affectedStrength)} | ${cutoff.affectedUnitCount} units | ${cutoff.affectedRegionCount} regions`,
          `  cities ${cutoff.affectedCities} | ports ${cutoff.affectedPorts} | component ${cutoff.affectedComponentIds.join(",")}`,
          `  source ${cutoff.sourceKind} | score ${cutoff.score.toFixed(1)} | reasons ${cutoff.reasonFlags.join(", ")}`,
        );
      }
      for (const risk of world.supplyDefense.risks
        .filter((item) => item.nationId === nationId && item.sectorId === front.id)
        .slice(0, 3)) {
        lines.push(
          `SUPPLY DEFENSE ${risk.regionId} | ${risk.status.toUpperCase()}`,
          `  at risk ${formatStrength(risk.threatenedStrength)} | ${risk.threatenedUnits} units | ${risk.threatenedRegions} regions`,
          `  cities ${risk.threatenedCities} | ports ${risk.threatenedPorts} | source ${risk.supplySourceType}`,
          `  defense ${formatStrength(risk.currentDefenderStrength)} / ${formatStrength(risk.requiredDefenseStrength)} | alternate routes accounted by shared cutoff analysis`,
          `  reasons ${risk.reasonFlags.join(", ")}`,
        );
      }
      for (const relief of world.supplyRelief.plans
        .filter((item) => item.nationId === nationId && item.sectorId === front.id)
        .slice(0, 2)) {
        lines.push(
          `SUPPLY RELIEF ${relief.isolatedComponentId} | ${relief.status.toUpperCase()}`,
          `  route ${relief.routeType} | target ${relief.primaryReconnectionRegion} | score ${relief.score.toFixed(1)}`,
          `  expected ${formatStrength(relief.expectedRestoredStrength)} / ${relief.expectedRestoredUnits} units | outside ${relief.outsideForceUnitIds.length} | inside ${relief.insideForceUnitIds.length}`,
          `  restored ${formatStrength(relief.actualRestoredStrength)} / ${relief.actualRestoredUnits} units | stable ${relief.stableSinceTick === null ? "pending" : Math.max(0, world.time.fastTick - relief.stableSinceTick)}`,
        );
      }
      for (const pocket of pockets) {
        const risk = pocket.containmentActual < pocket.containmentRequired ? "HIGH"
          : pocket.containmentActual < pocket.containmentRequired * 1.25 ? "MEDIUM" : "LOW";
        lines.push(
          `POCKET ${pocket.id}`,
          `  status ${pocket.status.toUpperCase()} | regions ${pocket.regionIds.length} | strength ${formatStrength(pocket.enemyStrength)} | cities ${pocket.cities}`,
          `  rear exits 0 | lifetime ${world.time.fastTick - pocket.createdTick}`,
          `  containment required ${formatStrength(pocket.containmentRequired)} | actual ${formatStrength(pocket.containmentActual)}`,
          `  reduction committed ${formatStrength(pocket.reductionStrength)} | target ${pocket.currentReductionTargetId ?? "none"}`,
          `  progress ${pocket.initialRegionCount} -> ${pocket.regionIds.length} regions | reopen risk ${risk}`,
        );
      }
      const stalled = getStalemateAssessment(world, nationId, enemyId);
      if (stalled) {
        const progress = getStrategicProgressAssessment(world, nationId, enemyId);
        const coverage = getFrontlineCoverage(world, front.id, nationId);
        const allocation = getFrontAllocation(world, front.id, nationId);
        const focused = stalled.schwerpunktSectorId === front.id;
        const pairAllocated = world.frontAllocations.allocations
          .filter((item) => {
            if (item.nationId !== nationId) return false;
            const itemSector = world.landFronts.operationalSectorsById.get(item.frontId);
            return !!itemSector &&
              (itemSector.nationAId === enemyId || itemSector.nationBId === enemyId);
          })
          .reduce((sum, item) => sum + item.allocatedStrength, 0);
        const reserve = world.strategicReserves.reservesByNationId.get(nationId);
        const reserveContribution = focused && reserve?.deployment?.targetFrontId === front.id &&
          reserve.deployment.status !== "returning"
          ? reserve.deployment.unitIds.reduce((sum, unitId) => {
            const unit = unitById.get(unitId);
            return sum + (unit ? getUnitCombatStrength(unit) : 0);
          }, 0)
          : 0;
        const offensiveStrength = Math.max(
          0,
          (allocation?.allocatedStrength ?? 0) - (coverage?.minimumRequiredStrength ?? 0),
        );
        const concentration = focused
          ? ((allocation?.allocatedStrength ?? 0) + reserveContribution) /
            Math.max(1, pairAllocated + reserveContribution)
          : 0;
        const preparationProgress = operation?.phase === "preparing"
          ? operation.readinessCompletion
          : operation ? 1 : 0;
        lines.push(
          `AI STATUS ${formatInactivityStatus(stalled.inactivityCategory)} | ${formatInactivityStatus(stalled.inactivityReason)}`,
          `  next evaluation tick ${stalled.nextEvaluationTick}`,
          `STALEMATE ${stalled.staticTicks} slow ticks | pressure ${stalled.pressure.toFixed(0)}${focused ? " | SCHWERPUNKT" : ""}`,
          `  reasons ${stalled.reasonFlags.join(", ") || "none"}`,
          `STRATEGIC PROGRESS ${progress?.score.toFixed(0) ?? "0"} | reset ${progress?.resetsPressure ? "YES" : "NO"}`,
          `  reasons ${progress?.reasonFlags.join(", ") || "none"} | last ${progress?.lastProgressReasons.join(", ") || "none"} @${progress?.lastProgressTick ?? "-"}`,
          `  displacement ${progress?.frontlineDisplacement ?? 0} | net gain ${progress?.netTerritorialGain ?? 0} | breakthrough persistence ${progress?.breakthroughPersistence ?? 0}`,
          `  capital approach ${progress?.capitalApproach ?? 0} | pressure reset ${progress?.resetsPressure ? "YES" : "NO"}`,
          `  inactivity blocker ${stalled.artificialInactivityBlocker ?? "none"}`,
          `  sector ${stalled.schwerpunktSectorId ?? "none"} | defense ${formatStrength(coverage?.minimumRequiredStrength ?? 0)} | allocated ${formatStrength(allocation?.allocatedStrength ?? 0)}`,
          `  surplus ${formatStrength(coverage?.offensiveSurplusStrength ?? 0)} | committed ${formatStrength(operation?.assignedStrength ?? 0)} | released ${formatStrength(stalled.releasedSecondaryStrength)}`,
          `  local ${formatRatio(operation?.localStrengthRatioAtAttack || getStrengthRatio(operation?.assignedStrength ?? 0, operation?.targetLocalDefenderStrength ?? 0))} | status ${(operation?.phase ?? (focused ? "concentrating" : "normal")).toUpperCase()}`,
          `  operation ${formatStrength(operation?.assignedStrength ?? 0)} / available ${formatStrength(operation?.offensiveSurplusAvailable ?? coverage?.offensiveSurplusStrength ?? 0)}`,
          ...(focused ? [
            `SCHWERPUNKT ${front.id} | pressure ${stalled.pressure.toFixed(0)} | concentration ${(concentration * 100).toFixed(0)}%`,
            `  offensive ${formatStrength(offensiveStrength)} | reserve ${formatStrength(reserveContribution)} | preparation ${(preparationProgress * 100).toFixed(0)}%`,
            `  phase ${(operation?.phase ?? "concentrating").toUpperCase()} | selected @${stalled.selectedAtTick ?? "-"}`,
          ] : []),
        );
      }
    }
    if (operation) {
      lines.push(`OP ${nationId} ${operation.phase.toUpperCase()} ${operation.id}`);
      if (selected) {
        lines.push(
          `  primary ${operation.primaryTargetRegionId} | coverage ${operation.targetCoverageState ?? "none"}`,
          `  local defense ${formatStrength(operation.targetLocalDefenderStrength)} | tactical ${operation.targetTacticalScore.toFixed(1)}`,
          `  APPROACHES ${operation.actualActiveApproachCount}/${operation.plannedApproachRegionIds.length} | readiness ${(operation.readinessCompletion * 100).toFixed(0)}% ${operation.synchronizationWaitTicks}t`,
          ...operation.approachGroups.map((group, index) =>
            `    A${index + 1} ${group.regionId} assigned ${formatStrength(group.currentAssignedStrength)}/${formatStrength(group.requiredStrength)} ready ${formatStrength(group.readyStrength)} (${(group.completion * 100).toFixed(0)}%) feasible ${formatStrength(group.feasibleStrength)} remaining ${formatStrength(group.remainingFeasibleStrength)} slack ${group.minimumArrivalSlack ?? "-"}t`
          ),
          `  MANIFEST ${operation.committedManifest.length} | committed ${formatStrength(operation.assignedStrength)} | feasible ${operation.preparationFeasible ? "YES" : "NO"}`,
          `  PREPARATION LEASE ${operation.preparationLeaseEndedAtTick === null ? "ACTIVE" : `ENDED @${operation.preparationLeaseEndedAtTick}`} | overrides ${operation.leaseOverrideReasons.join(", ") || "none"}`,
          `  reasons ${operation.reasonFlags.join(", ")}`,
          ...(operation.supplyCutoffObjective ? [
            `  CUTOFF target ${operation.supplyCutoffObjective.targetRegionId} | predicted ${formatStrength(operation.supplyCutoffObjective.affectedStrength)}`,
            `    actual ${formatStrength(operation.supplyCutoffConfirmation?.actualIsolatedStrength ?? 0)} | state ${operation.supplyCutoffConfirmation?.state.toUpperCase() ?? "PENDING"}`,
          ] : []),
        );
        const battle = world.battles.find((candidate) =>
          candidate.mesoId === operation.primaryTargetRegionId &&
          candidate.attackerNationId === operation.nationId
        );
        if (battle) {
          lines.push(
            `  ATTACK DIRECTIONS ${battle.attackDirectionCount}`,
            ...battle.attackSourceRegionIds.map((regionId) =>
              `    ${regionId} ${formatStrength(battle.attackStrengthBySourceRegion.get(regionId) ?? 0)}`
            ),
            `  FLANK MODIFIER x${battle.multiDirectionModifier.toFixed(2)}`,
          );
        }
        if (operation.exploitationStartedAtTick !== null) {
          const startedAt = world.instrumentation ? performance.now() : 0;
          lines.push(
            `  E target ${operation.exploitationTargetRegionId ?? "none"} | depth ${operation.exploitationDepth}`,
            `  force ${operation.exploitationUnitIds.length}/${operation.assignedUnitIds.length} units (${formatStrength(operation.exploitationForceStrength)})`,
            `  ${operation.exploitationTargetCoverageState ?? "none"} | local ${formatStrength(operation.exploitationTargetLocalEnemyStrength)} | ratio ${formatRatio(getStrengthRatio(operation.exploitationForceStrength, operation.exploitationTargetLocalEnemyStrength))} | score ${operation.exploitationTargetScore.toFixed(1)}`,
            `  stop ${operation.exploitationStopReason ?? "none"}`,
          );
          world.instrumentation?.recordDuration(
            "debugOverlay.exploitation",
            performance.now() - startedAt,
          );
        }
      }
    }
    if (selected && candidate) {
      const committedStrength = candidate.manifest.reduce(
        (sum, assignment) => sum + assignment.strength,
        0,
      );
      const minimumArrivalSlack = candidate.manifest.length > 0
        ? Math.min(...candidate.manifest.map((assignment) => assignment.arrivalSlack))
        : null;
      lines.push(
        `CANDIDATE ${nationId} ${candidate.feasible ? "FEASIBLE" : "REJECTED"}`,
        `  target ${candidate.primaryTargetRegionId} | manifest ${candidate.manifest.length} | strength ${formatStrength(committedStrength)}`,
        `  arrival slack min ${minimumArrivalSlack ?? "-"}t | evaluated @${candidate.evaluatedAtTick} (${candidate.evaluationCount}x)`,
        `  reasons ${candidate.rejectionReasons.join(", ") || "none"}`,
        ...candidate.plannedApproachRegionIds.map((regionId, index) =>
          `    A${index + 1} ${regionId} on-time ${formatStrength(candidate.onTimeStrengthByApproach.get(regionId) ?? 0)} / required ${formatStrength(candidate.requiredStrengthByApproach.get(regionId) ?? 0)}`
        ),
      );
    }
    const collapse = world.collapseAdvances.advanceByNationId.get(nationId);
    if (collapse?.sourceSectorId === front.id) {
      const strength = collapse.unitIds.reduce((sum, id) => {
        const unit = unitById.get(id);
        return sum + (unit ? getUnitCombatStrength(unit) : 0);
      }, 0);
      lines.push(
        `COLLAPSE ADVANCE ${collapse.enemyNationId}`,
        `  phase ${collapse.phase.toUpperCase()} | units ${collapse.unitIds.length} | strength ${formatStrength(strength)}`,
        `  target ${collapse.currentTargetRegionId} | depth ${collapse.targetRegionIds.length}/${WORLD_BALANCE.war.landFront.collapseAdvance.maximumDepth}`,
        `  component ${collapse.topologyComponentId} | topology ${collapse.topologyScore.toFixed(0)}`,
        `  reason ${collapse.topologyReasonFlags.join(", ")}`,
      );
    }
    const retreat = getRetreatPlanForFront(world, front.id, nationId);
    if (retreat) lines.push(`RET ${nationId} ${retreat.phase.toUpperCase()} ${retreat.id}`);
  }
  for (const reserve of world.strategicReserves.reserves) {
    const deployment = reserve.deployment;
    if (!deployment || deployment.status === "returning" || deployment.targetFrontId !== front.id) continue;
    const strength = deployment.unitIds.reduce((sum, unitId) => {
      const unit = unitById.get(unitId);
      return sum + (unit ? getUnitCombatStrength(unit) : 0);
    }, 0);
    lines.push(`RES ${reserve.nationId} ${formatStrength(strength)} | ${deployment.unitIds.length} units`);
  }
}

function formatInactivityStatus(value: string): string {
  return value.replaceAll("-", " ").toUpperCase();
}

function formatNationSide(
  world: WorldState,
  front: PhysicalFront | OperationalSector,
  nationId: NationId,
): string[] {
  const side = front.nationAId === nationId ? front.sideA : front.sideB;
  const enemy = front.nationAId === nationId ? front.sideB : front.sideA;
  const plan = getFrontPlan(world, front.id, nationId);
  return [
    `${nationId}  ${(plan?.posture ?? "-").toUpperCase()}`,
    `  ${formatStrength(side.strength)} / ${formatStrength(plan?.desiredStrength ?? 0)} | ratio ${formatRatio(getStrengthRatio(side.strength, enemy.strength))} | priority ${formatPriority(plan?.priority)}`,
  ];
}

function drawFrontMarkers(
  layer: Container,
  world: WorldState,
  front: OperationalSector,
  color: number,
): void {
  for (const nationId of [front.nationAId, front.nationBId]) {
    const coverage = getFrontlineCoverage(world, front.id, nationId);
    if (coverage) {
      for (const position of coverage.positions) {
        const markerColor = position.state === "covered" ? 0x55d67a : position.state === "weak" ? 0xffc247 : 0xff4f64;
        const label = position.state === "covered" ? `${position.defenderUnitIds.length}` : position.state === "weak" ? "!" : "×";
        drawMarker(layer, world, position.friendlyRegionId, label, markerColor, "circle");
      }
    }
    const operation = getOffensiveOperationForFront(world, front.id, nationId);
    if (operation) {
      drawMarker(layer, world, operation.stagingRegionId, "S", color, "circle");
      operation.plannedApproachRegionIds.forEach((regionId, index) => {
        drawMarker(layer, world, regionId, `A${index + 1}`, color, "circle");
      });
      const primaryLabel = operation.targetCoverageState === "gap"
        ? "G"
        : operation.targetCoverageState === "weak"
          ? "W"
          : "P";
      const objectiveLabel = operation.pocketClosureObjective ? "K"
        : operation.pocketReductionObjective ? "R" : primaryLabel;
      drawMarker(layer, world, operation.primaryTargetRegionId, objectiveLabel, color, "diamond");
      for (const targetId of operation.supportingTargetRegionIds) {
        drawMarker(layer, world, targetId, "+", color, "diamond");
      }
      if (operation.phase === "exploiting" && operation.exploitationTargetRegionId) {
        const startedAt = world.instrumentation ? performance.now() : 0;
        drawMarker(
          layer,
          world,
          operation.exploitationTargetRegionId,
          "E",
          0xff8c42,
          "diamond",
        );
        world.instrumentation?.recordDuration(
          "debugOverlay.exploitation",
          performance.now() - startedAt,
        );
      }
    }
    const collapse = world.collapseAdvances.advanceByNationId.get(nationId);
    if (collapse?.sourceSectorId === front.id) {
      drawMarker(
        layer,
        world,
        collapse.currentTargetRegionId,
        "C",
        color,
        "diamond",
      );
    }
    const retreat = getRetreatPlanForFront(world, front.id, nationId);
    if (retreat) {
      for (const fallbackId of retreat.fallbackRegionIds) {
        drawMarker(layer, world, fallbackId, "R", color, "circle");
      }
    }
  }
}

function drawSupplySourceMarkers(layer: Container, world: WorldState): void {
  for (const assessment of world.supplyAssessment.assessments) {
    for (const regionId of assessment.supplySourceRegionIds) {
      drawMarker(layer, world, regionId, "S", 0x5be7c4, "diamond");
    }
  }
}

function drawSupplyCutoffMarkers(layer: Container, world: WorldState): void {
  const targetIds = new Set<MesoRegionId>();
  for (const operation of world.offensiveOperations.operations) {
    if (!operation.supplyCutoffObjective || operation.phase === "recovering") continue;
    targetIds.add(operation.supplyCutoffObjective.targetRegionId);
  }
  for (const regionId of targetIds) {
    drawMarker(layer, world, regionId, "X", 0xffd740, "diamond");
  }
}

function drawSupplyDefenseMarkers(layer: Container, world: WorldState): void {
  for (const risk of world.supplyDefense.risks) {
    if (risk.status !== "critical") continue;
    drawMarker(layer, world, risk.regionId, "D", 0xff6b6b, "diamond");
  }
}

function drawSupplyReliefMarkers(layer: Container, world: WorldState): void {
  for (const plan of world.supplyRelief.plans) {
    if (plan.status === "success" || plan.status === "abandoned" || plan.status === "cancelled") continue;
    drawMarker(layer, world, plan.primaryReconnectionRegion, "L", 0x7cfc00, "diamond");
  }
}

function drawMaritimeSupplyLinks(layer: Container, world: WorldState): void {
  const selectedByPair = new Map<string, WorldState["supplyAssessment"]["maritimeLinks"][number]>();
  for (const link of world.supplyAssessment.maritimeLinks) {
    const pair = [link.sourcePortId, link.destinationPortId].sort().join("<->");
    const current = selectedByPair.get(pair);
    if (!current || (!current.active && link.active)) selectedByPair.set(pair, link);
  }
  for (const link of selectedByPair.values()) {
    const protection = getMaritimeLinkProtection(world, link.id);
    const color = !link.active
      ? 0xff6b6b
      : protection.protectionState === "PROTECTED"
        ? 0x40c4ff
        : protection.requiredEscortCount > 0 ? 0xffd740 : 0x5be7c4;
    if (link.routeRegionIds.length > 1) {
      const geometry = new Graphics();
      geometry.name = `MaritimeSupplyRoute:${link.id}`;
      geometry.lineStyle({ width: 2, color, alpha: 0.72, cap: "round", join: "round" });
      for (let index = 1; index < link.routeRegionIds.length; index += 1) {
        const from = world.cache.mesoById.get(link.routeRegionIds[index - 1])?.center;
        const to = world.cache.mesoById.get(link.routeRegionIds[index])?.center;
        if (!from || !to) continue;
        geometry.moveTo(from.x, from.y);
        geometry.lineTo(to.x, to.y);
      }
      layer.addChild(geometry);
    }
    drawMarker(layer, world, link.sourcePortId, "M", color, "circle");
    drawMarker(layer, world, link.destinationPortId, "M", color, "circle");
    for (const transportId of link.assignedTransportIds) {
      const transport = world.units.find((unit) => unit.id === transportId);
      if (transport) drawMarker(layer, world, transport.regionId, "T", color, "diamond");
    }
    const convoy = world.supplyAssessment.convoys.convoyByLinkId.get(link.id);
    const convoyTransport = convoy?.transportId
      ? world.units.find((unit) => unit.id === convoy.transportId)
      : undefined;
    if (convoy && convoyTransport) {
      drawMarker(layer, world, convoyTransport.regionId, "C", color, "circle");
    }
    for (const escortId of protection.assignedEscortIds) {
      const escort = world.units.find((unit) => unit.id === escortId);
      if (escort) drawMarker(layer, world, escort.regionId, "E", color, "diamond");
    }
    const raids = world.supplyAssessment.maritimeInterdiction.assignmentsByLinkId.get(link.id) ?? [];
    for (const raid of raids) {
      const raider = world.units.find((unit) => unit.id === raid.combatShipId);
      const markerRegionId = raider?.regionId ?? raid.routeRegionIds.find((regionId) =>
        world.cache.mesoById.get(regionId)?.type === "sea"
      );
      if (markerRegionId) drawMarker(layer, world, markerRegionId, "I", 0xff3d81, "diamond");
    }
    const source = world.cache.mesoById.get(link.sourcePortId)?.center;
    const destination = world.cache.mesoById.get(link.destinationPortId)?.center;
    if (!source || !destination) continue;
    const label = createMaritimeSupplyLabel(world, link, color);
    label.position.set((source.x + destination.x) / 2 + 6, (source.y + destination.y) / 2 + 6);
    layer.addChild(label);
  }
}

function drawNavalMissions(layer: Container, world: WorldState): void {
  const markers = { ESCORT: "E", RAID: "R", INTERCEPT: "I", BLOCKADE: "B", RESERVE: "N" } as const;
  const colors = { ESCORT: 0x40c4ff, RAID: 0xff3d81, INTERCEPT: 0xffd740,
    BLOCKADE: 0xff7043, RESERVE: 0x82b1ff } as const;
  for (const mission of world.supplyAssessment.navalStrategy.missions) {
    for (const shipId of mission.shipIds) {
      const ship = world.units.find((unit) => unit.id === shipId);
      if (!ship) continue;
      drawMarker(layer, world, ship.regionId, markers[mission.type], colors[mission.type], "diamond");
      const center = world.cache.mesoById.get(ship.regionId)?.center;
      if (!center) continue;
      const label = new Text(formatNavalMission(world, shipId), LABEL_STYLE);
      label.resolution = 2;
      label.position.set(center.x + 11, center.y + 11);
      layer.addChild(label);
    }
  }
}

function drawAmphibiousOperations(layer: Container, world: WorldState): void {
  for (const campaign of world.amphibiousOperations.bridgeheadCampaigns) {
    drawMarker(layer, world, campaign.destinationPortId, "B",
      campaign.status === "active" ? 0x00e676 : 0x90a4ae, "diamond");
    const center = world.cache.mesoById.get(campaign.destinationPortId)?.center;
    if (!center) continue;
    const label = new Text(formatBridgeheadCampaign(world, campaign), LABEL_STYLE);
    label.resolution = 2;
    label.position.set(center.x + 11, center.y - 72);
    layer.addChild(label);
  }
  for (const demand of world.amphibiousOperations.capabilityDemands) {
    if (demand.operationId !== null || demand.state === "expired" || demand.state === "cancelled") continue;
    drawMarker(layer, world, demand.destinationPortId, "C", 0x26c6da, "diamond");
    const center = world.cache.mesoById.get(demand.destinationPortId)?.center;
    if (!center) continue;
    const label = new Text(formatAmphibiousCapabilityDemand(world, demand), LABEL_STYLE);
    label.resolution = 2;
    label.position.set(center.x + 11, center.y + 11);
    layer.addChild(label);
  }
  for (const operation of world.amphibiousOperations.operations) {
    if (operation.phase === "landed" || operation.phase === "cancelled") continue;
    drawMarker(layer, world, operation.destinationPortId, "A", 0x7c4dff, "diamond");
    const center = world.cache.mesoById.get(operation.destinationPortId)?.center;
    if (!center) continue;
    const label = new Text(formatAmphibiousOperationValidation(world, operation), LABEL_STYLE);
    label.resolution = 2;
    label.position.set(center.x + 11, center.y + 11);
    layer.addChild(label);
  }
  const latestRejectionByNation = new Map<string, WorldState["amphibiousOperations"]["launchRejections"][number]>();
  for (const rejection of world.amphibiousOperations.launchRejections) {
    latestRejectionByNation.set(rejection.nationId, rejection);
  }
  for (const rejection of latestRejectionByNation.values()) {
    drawMarker(layer, world, rejection.destinationPortId, "X", 0xff5252, "diamond");
    const center = world.cache.mesoById.get(rejection.destinationPortId)?.center;
    if (!center) continue;
    const label = new Text(formatAmphibiousLaunchFeasibility(rejection), LABEL_STYLE);
    label.resolution = 2;
    label.position.set(center.x + 11, center.y + 11);
    layer.addChild(label);
  }
}

export function formatBridgeheadCampaign(
  world: WorldState,
  campaign: WorldState["amphibiousOperations"]["bridgeheadCampaigns"][number],
): string {
  const age = Math.max(0, world.time.fastTick - campaign.createdAtTick);
  return [
    `BRIDGEHEAD ${campaign.status.toUpperCase()} | supply ${campaign.supplyStatus}`,
    `strength ${campaign.currentStrength.toFixed(0)}/${campaign.desiredStrength.toFixed(0)} | deficit ${campaign.reinforcementDeficit.toFixed(0)}`,
    `wave ${campaign.currentWave} (${campaign.completedWaves} complete) | age ${age}`,
    `lift ${campaign.currentTransportCapacity} | escort cap ${campaign.currentEscortCapacity} | pending T${campaign.pendingTransportCount} E${campaign.pendingEscortCount}`,
    `waiting ${campaign.waitingReason}`,
  ].join("\n");
}

export function formatAmphibiousCapabilityDemand(
  world: WorldState,
  demand: WorldState["amphibiousOperations"]["capabilityDemands"][number],
): string {
  const unitById = new Map(world.units.map((unit) => [unit.id, unit]));
  const atDeparture = (ids: readonly UnitId[]): number => ids.filter((id) =>
    unitById.get(id)?.regionId === demand.departurePortId).length;
  const transportReady = atDeparture(demand.assignedTransportIds);
  const escortReady = atDeparture(demand.assignedEscortIds);
  const forceReady = atDeparture(demand.assignedLandingUnitIds);
  const assembled = transportReady + escortReady + forceReady;
  const assigned = demand.assignedTransportIds.length + demand.assignedEscortIds.length +
    demand.assignedLandingUnitIds.length;
  return [
    "AMPHIBIOUS CAPABILITY",
    `state ${demand.state}`,
    `strength ${demand.availableLandingStrength.toFixed(0)}/${demand.requiredLandingStrength.toFixed(0)}`,
    `site score ${demand.landingScore.toFixed(1)} | value ${demand.strategicValue.toFixed(0)}`,
    `defenders ${demand.immediateDefenderStrength.toFixed(0)} | reaction ${demand.reactionStrength.toFixed(0)}`,
    `selected ${demand.selectedReason}`,
    `transports ${demand.assignedTransportIds.length}/${demand.desiredTransportCount} (${transportReady} ready)`,
    `escorts ${demand.assignedEscortIds.length}/${demand.desiredEscortCount} (${escortReady} ready)`,
    `force ${demand.assignedLandingUnitIds.length}/${demand.desiredLandingUnitCount} (${forceReady} ready)`,
    `launch ${demand.launchReady && demand.state === "ready" ? "READY" : "WAIT"} ratio ${demand.assaultRatio.toFixed(2)}`,
    `assembly ${assembled}/${assigned} ETA ${demand.assemblyEtaTicks}`,
    `waiting ${demand.waitingReason ?? "none"}`,
  ].join("\n");
}

export function formatAmphibiousOperationValidation(
  world: WorldState,
  operation: WorldState["amphibiousOperations"]["operations"][number],
): string {
  const validation = getAmphibiousOperationValidation(world, operation);
  const transports = operation.transportIds.map((id) => world.units.find((unit) => unit.id === id));
  return [
    "AMPHIBIOUS OPERATION",
    `phase ${validation.phase}`,
    `strength ${operation.assignedStrength.toFixed(0)}/${operation.requiredStrength.toFixed(0)}`,
    `site score ${operation.landingScore.toFixed(1)} | value ${operation.strategicValue.toFixed(0)}`,
    `defenders ${operation.immediateDefenderStrength.toFixed(0)} | reaction ${operation.reactionStrength.toFixed(0)}`,
    `selected ${operation.selectedReason}`,
    `transports ${transports.filter(Boolean).length}/${operation.transportIds.length}`,
    `escorts ${operation.escortIds.length}/${operation.requiredEscortCount}`,
    `launch ${operation.launchedAtTick === null ? "WAIT" : "LAUNCHED"} ratio ${(operation.assignedStrength / Math.max(0.5, operation.requiredStrength)).toFixed(2)}`,
    `convoys ${operation.convoyIds.length} positions ${transports.map((unit) => unit?.regionId ?? "lost").join(",")}`,
    `waiting ${validation.failures.join(", ") || "none"}`,
  ].join("\n");
}

export function formatAmphibiousLaunchFeasibility(
  feasibility: WorldState["amphibiousOperations"]["operations"][number]["launchFeasibility"],
): string {
  return [
    `AMPHIBIOUS LAUNCH ${feasibility.accepted ? "FEASIBLE" : "REJECTED"}`,
    "fleet assembled",
    `embarkation ${feasibility.estimatedEmbarkationTicks} ticks`,
    `voyage ${feasibility.estimatedVoyageTicks} ticks`,
    `landing ${feasibility.estimatedLandingTicks} ticks`,
    `ETA ${feasibility.estimatedCompletionTicks} ticks`,
    `window ${feasibility.estimatedOpportunityWindowTicks} ticks`,
    `margin ${feasibility.safetyMarginTicks} ticks`,
    `reason ${feasibility.reason ?? "accepted"}`,
  ].join("\n");
}

export function formatNavalMission(world: WorldState, shipId: string): string {
  const mission = world.supplyAssessment.navalStrategy.missions.find((item) =>
    item.shipIds.includes(shipId as never));
  if (!mission) return `NAVAL MISSION\nship ${shipId}\nmission UNASSIGNED`;
  const target = mission.targetConvoyId ? `convoy ${mission.targetConvoyId}`
    : mission.targetLinkId ? `link ${mission.targetLinkId}`
      : mission.targetPortId ? `port ${mission.targetPortId}`
        : mission.targetShipId ? `ship ${mission.targetShipId}` : "none";
  return ["NAVAL MISSION", `ship ${shipId}`, `mission ${mission.type}`, `mission id ${mission.id}`,
    `priority ${mission.priority.toFixed(1)}`, `target ${target}`,
    `reason ${mission.reasonFlags.join(", ") || "none"}`,
    `commitment ${Math.max(0, world.time.fastTick - mission.createdTick)} ticks`].join("\n");
}

export function formatNavalStrategySummary(world: WorldState, nationId: string): string {
  const missions = world.supplyAssessment.navalStrategy.missions.filter((item) => item.nationId === nationId);
  const force = world.supplyAssessment.navalStrategy.assessments
    .find((assessment) => assessment.nationId === nationId)?.desiredForce;
  const count = (type: typeof missions[number]["type"]): number => missions
    .filter((mission) => mission.type === type).reduce((sum, mission) => sum + mission.shipIds.length, 0);
  return ["NAVAL AI", `CombatShips ${force?.currentCombatShips ?? missions.reduce((sum, mission) => sum + mission.shipIds.length, 0)} / desired ${force?.desiredCombatShips ?? 0}`,
    `Deficit ${force?.deficit ?? 0}`,
    `Reasons ${force?.reasons.join(", ") || "none"}`,
    `Production ${force && force.deficit > 0 && force.hasUsablePort ? "CombatShip requested" : "none"}`,
    `Escort ${count("ESCORT")}`, `Raid ${count("RAID")}`, `Intercept ${count("INTERCEPT")}`,
    `Blockade ${count("BLOCKADE")}`, `Reserve ${count("RESERVE")}`].join("\n");
}

function drawStrategicThreatSummary(layer: Container, world: WorldState): void {
  const container = new Container();
  container.name = "StrategicThreatObservationSummary";
  container.eventMode = "none";
  const text = new Text(formatStrategicThreatSummary(world), LABEL_STYLE);
  text.resolution = 2;
  const bounds = text.getLocalBounds();
  const padding = 6;
  const background = new Graphics();
  background.beginFill(0x081018, 0.92);
  background.lineStyle(1.5, 0xb388ff, 0.95);
  background.drawRoundedRect(0, 0, bounds.width + padding * 2, bounds.height + padding * 2, 4);
  background.endFill();
  text.position.set(padding, padding);
  container.position.set(8, 8);
  container.addChild(background, text);
  layer.addChild(container);
}

export function formatStrategicThreatSummary(world: WorldState): string {
  const diagnostics = world.productionDiagnostics;
  const lines = [
    "UNIT CAPACITY",
    `Land Units ${diagnostics.currentLandUnits} | Land Capacity ${WORLD_BALANCE.production.maxLandUnits}/nation`,
    `Naval Units ${diagnostics.currentNavalUnits} | Naval Capacity ${WORLD_BALANCE.production.maxNavalUnits}/nation`,
  ];
  if (world.strategicThreatObservation.observations.length > 0) {
    lines.push("", "STRATEGIC THREAT");
  }
  for (const observation of world.strategicThreatObservation.observations) {
    const largestThreat = world.commonThreatCoalitions.largestThreatByNationId
      .get(observation.nationId) ?? "-";
    const coalition = world.commonThreatCoalitions.coalitionByMemberNationId
      .get(observation.nationId);
    lines.push(`${formatStrategicThreatNationLine(observation)} | LT ${largestThreat}`);
    if (coalition) lines.push(`  COAL ${coalition.memberNationIds.join("+")} → ${coalition.targetNationId} | age ${coalition.age} | ${coalition.formationReason}${coalition.pendingDissolutionReason ? ` | pending ${coalition.pendingDissolutionReason}` : ""}`);
  }
  const dissolution = world.commonThreatCoalitions.lastDissolutions[0];
  if (dissolution) lines.push(`LAST DISSOLVE ${dissolution.memberNationIds.join("+")} → ${dissolution.targetNationId} | age ${dissolution.duration} | ${dissolution.reason}`);
  const intents = world.warIntent.assessments.slice(0, 6);
  if (intents.length > 0) lines.push("", "WAR INTENT");
  for (const intent of intents) {
    lines.push(`${intent.aggressorId} → ${intent.targetNationId} ${intent.route} | ${intent.score.toFixed(0)} | O +${intent.opportunity.toFixed(0)} T +${intent.threatResponse.toFixed(0)} V +${intent.strategicValue.toFixed(0)} C -${intent.expectedCost.toFixed(0)} K -${intent.existingCommitment.toFixed(0)} X -${intent.externalExposure.toFixed(0)}`);
    lines.push(`  ${intent.dominantReason} | ${intent.declared ? "DECLARE" : `reject: ${intent.rejectedReasons.join(", ")}`}`);
  }
  return lines.join("\n");
}

function formatStrategicThreatNationLine(observation: StrategicNationObservation): string {
  const momentum = observation.momentum.score;
  const momentumText = `${momentum >= 0 ? "+" : ""}${momentum.toFixed(0)}`;
  const trend = observation.momentum.trend === "rising" ? "↑" :
    observation.momentum.trend === "falling" ? "↓" : "→";
  return `#${observation.threatRank} ${observation.nationId} | P ${observation.power.score.toFixed(0)} | M ${momentumText}${trend} | T ${observation.threatScore.toFixed(0)} | G ${signed(observation.momentum.territoryGrowth)}/${signed(observation.momentum.cityGrowth)} | W ${observation.existingWars} | SP ${observation.strategicProgress.toFixed(0)} | Sea ${observation.maritimeCapability}`;
}

function signed(value: number): string {
  return `${value >= 0 ? "+" : ""}${value}`;
}

function createMaritimeSupplyLabel(
  world: WorldState,
  link: WorldState["supplyAssessment"]["maritimeLinks"][number],
  color: number,
): Container {
  const container = new Container();
  container.name = `MaritimeSupplyLabel:${link.id}`;
  container.eventMode = "none";
  const text = new Text(formatMaritimeSupplyLink(world, link), LABEL_STYLE);
  text.resolution = 2;
  const bounds = text.getLocalBounds();
  const padding = 5;
  const background = new Graphics();
  background.beginFill(0x081018, 0.88);
  background.lineStyle(1.5, color, 0.95);
  background.drawRoundedRect(0, 0, bounds.width + padding * 2, bounds.height + padding * 2, 4);
  background.endFill();
  text.position.set(padding, padding);
  container.addChild(background, text);
  return container;
}

export function formatMaritimeSupplyLink(
  world: WorldState,
  link: WorldState["supplyAssessment"]["maritimeLinks"][number],
): string {
  const source = link.sourceLandComponentId
    ? world.supplyAssessment.componentById.get(link.sourceLandComponentId)
    : undefined;
  const destination = link.destinationLandComponentId
    ? world.supplyAssessment.componentById.get(link.destinationLandComponentId)
    : undefined;
  const assignments = link.assignedTransportIds.map((transportId) =>
    world.supplyAssessment.maritimeLogistics.assignmentByTransportId.get(transportId)
  );
  const protection = getMaritimeLinkProtection(world, link.id);
  const escortAssignments = protection.assignedEscortIds.map((escortId) =>
    world.supplyAssessment.maritimeEscorts.assignmentByCombatShipId.get(escortId)
  );
  const demand = world.supplyAssessment.maritimeEscorts.demands.find((item) =>
    item.maritimeLinkId === link.id
  );
  const raids = world.supplyAssessment.maritimeInterdiction.assignmentsByLinkId.get(link.id) ?? [];
  const interdicted = world.supplyAssessment.maritimeInterdiction.interdictedLinkIds.has(link.id);
  const convoy = world.supplyAssessment.convoys.convoyByLinkId.get(link.id);
  const convoyTransport = convoy?.transportId
    ? world.units.find((unit) => unit.id === convoy.transportId)
    : undefined;
  return [
    "MOVING CONVOY",
    `link ${link.id}`,
    `${link.sourcePortId} -> ${link.destinationPortId}`,
    "CONVOY",
    `  ID ${convoy?.id ?? "none"}`,
    `  transport ${convoy?.transportId ?? "none"}`,
    `  escorts ${convoy?.escortIds.join(", ") || "none"}`,
    `  position ${convoyTransport?.regionId ?? "unavailable"}`,
    `  waypoint ${convoy?.currentWaypoint ?? "-"}`,
    `  destination ${convoy?.currentDestinationId ?? "-"}`,
    `  progress ${((convoy?.progress ?? 0) * 100).toFixed(1)}%`,
    `  mission ${convoy?.mission ?? "none"}`,
    `  state ${convoy?.state.toUpperCase() ?? "UNAVAILABLE"}`,
    `  assigned raid ${raids.map((raid) => raid.combatShipId).join(", ") || "none"}`,
    `  supply link ${convoy?.maritimeLinkId ?? link.id}`,
    "TRANSPORT",
    `  ${link.assignedTransportIds.join(", ") || "none"}`,
    `  ${link.active ? "ACTIVE" : "INACTIVE"} (${assignments.map((assignment) => assignment?.status ?? "unavailable").join(", ") || "unavailable"})`,
    "ESCORT",
    `  ${protection.assignedEscortIds.join(", ") || "none"}`,
    `  ${escortAssignments.map((assignment) => assignment?.status.toUpperCase() ?? "UNAVAILABLE").join(", ") || "UNAVAILABLE"}`,
    "PROTECTION",
    `  ${protection.protectionState}`,
    `  support ${protection.assignedEscortIds.length}/${protection.requiredEscortCount}`,
    "INTERDICTION",
    `  raid target ${raids.length > 0 ? link.id : "none"}`,
    `  target score ${raids.map((raid) => raid.targetScore.toFixed(1)).join(", ") || "-"}`,
    `  raiding CombatShip ${raids.map((raid) => raid.combatShipId).join(", ") || "none"}`,
    `  interdicted ${interdicted ? "YES" : "NO"}`,
    `  route ${link.routeRegionIds.join(" -> ")}`,
    `  reason ${raids.map((raid) => raid.targetReason).join(" | ") || "no enemy raid assignment"}`,
    `source component: ${source?.supplied ? "SUPPLIED" : "ISOLATED"}`,
    `destination component: ${destination?.supplied ? "SUPPLIED" : "ISOLATED"}`,
    `remote: units ${demand?.remoteUnitCount ?? 0}`,
    `  strength ${(demand?.remoteStrength ?? destination?.strength ?? 0).toFixed(1)}`,
    `route length: ${Math.max(0, link.routeRegionIds.length - 1)}`,
    `SUPPLY: ${destination?.supplied ? "CONNECTED" : "ISOLATED"}`,
    ...(protection.skippedReason ? [`escort reason: ${protection.skippedReason}`] : []),
    ...(!link.active ? [`reason: ${link.reason ?? "route-invalid"}`] : []),
  ].join("\n");
}

function drawMarker(
  layer: Container,
  world: WorldState,
  regionId: MesoRegionId,
  label: string,
  color: number,
  shape: "circle" | "diamond",
): void {
  const center = world.cache.mesoById.get(regionId)?.center;
  if (!center) return;
  const marker = new Container();
  marker.name = `FrontDebugMarker:${label}:${regionId}`;
  marker.position.set(center.x, center.y);
  const graphics = new Graphics();
  graphics.beginFill(color, 0.9);
  graphics.lineStyle(1.5, 0x05070a, 1);
  if (shape === "circle") {
    graphics.drawCircle(0, 0, 8);
  } else {
    graphics.drawPolygon([0, -9, 9, 0, 0, 9, -9, 0]);
  }
  graphics.endFill();
  const text = new Text(label, MARKER_STYLE);
  text.anchor.set(0.5);
  marker.addChild(graphics, text);
  layer.addChild(marker);
}

function indexMesoBorderSegments(microRegions: readonly MicroRegion[]): Map<string, Segment[]> {
  const result = new Map<string, Segment[]>();
  const microById = getMicroRegionByIdMap([...microRegions]);
  for (const region of microRegions) {
    if (!region.mesoRegionId) continue;
    for (const neighborId of region.neighbors) {
      if (region.id >= neighborId) continue;
      const neighbor = microById.get(neighborId);
      if (!neighbor?.mesoRegionId || neighbor.mesoRegionId === region.mesoRegionId) continue;
      const segments = findSharedSegments(region, neighbor);
      if (segments.length === 0) continue;
      const key = mesoPairKey(region.mesoRegionId, neighbor.mesoRegionId);
      const existing = result.get(key);
      if (existing) existing.push(...segments);
      else result.set(key, segments);
    }
  }
  return result;
}

function getFrontAnchor(front: PhysicalFront | OperationalSector, world: WorldState): { x: number; y: number } {
  let x = 0;
  let y = 0;
  let count = 0;
  for (const edge of front.borderEdges) {
    const a = world.cache.mesoById.get(edge.regionAId)?.center;
    const b = world.cache.mesoById.get(edge.regionBId)?.center;
    if (!a || !b) continue;
    x += (a.x + b.x) / 2;
    y += (a.y + b.y) / 2;
    count += 1;
  }
  return count > 0 ? { x: x / count, y: y / count } : { x: 0, y: 0 };
}

function readVersions(world: WorldState): OverlayVersions {
  return {
    fronts: world.landFronts.version,
    frontMetrics: world.landFronts.metricsVersion,
    plans: world.frontPlans.version,
    operations: world.offensiveOperations.version,
    collapseAdvances: world.collapseAdvances.version,
    battlefieldTopology: world.battlefieldTopology.version,
    supplyAssessment: world.supplyAssessment.version,
    maritimeInterdiction: world.supplyAssessment.maritimeInterdiction.version,
    navalStrategy: world.supplyAssessment.navalStrategy.version,
    amphibiousOperations: world.amphibiousOperations.version,
    convoys: world.supplyAssessment.convoys.version,
    isolationEffects: world.isolationEffects.version,
    productionDiagnostics: world.productionDiagnostics.version,
    supplyCutoffs: world.supplyCutoffs.version,
    supplyDefense: world.supplyDefense.version,
    supplyRelief: world.supplyRelief.version,
    retreats: world.retreatPlans.version,
    coverage: world.frontlineCoverage.version,
    stalemate: world.stalematePressure.version,
    strategicThreat: world.strategicThreatObservation.version,
    coalitions: world.commonThreatCoalitions.version,
    reserveDeployments: world.strategicReserves.reserves
      .map((reserve) => {
        const deployment = reserve.deployment;
        return deployment
          ? `${reserve.nationId}:${deployment.targetFrontId ?? "-"}:${deployment.status}:${deployment.unitIds.join(",")}`
          : "";
      })
      .join("|"),
    battles: world.battles.map((battle) =>
      `${battle.id}:${battle.attackDirectionCount}:${battle.multiDirectionModifier}`
    ).join("|"),
  };
}

function versionsEqual(a: OverlayVersions, b: OverlayVersions): boolean {
  return a.fronts === b.fronts && a.frontMetrics === b.frontMetrics &&
    a.plans === b.plans && a.operations === b.operations && a.collapseAdvances === b.collapseAdvances && a.battlefieldTopology === b.battlefieldTopology && a.supplyAssessment === b.supplyAssessment && a.maritimeInterdiction === b.maritimeInterdiction && a.navalStrategy === b.navalStrategy && a.amphibiousOperations === b.amphibiousOperations && a.convoys === b.convoys && a.isolationEffects === b.isolationEffects && a.productionDiagnostics === b.productionDiagnostics && a.supplyCutoffs === b.supplyCutoffs && a.supplyDefense === b.supplyDefense && a.supplyRelief === b.supplyRelief &&
    a.retreats === b.retreats && a.coverage === b.coverage && a.stalemate === b.stalemate &&
    a.strategicThreat === b.strategicThreat && a.coalitions === b.coalitions &&
    a.reserveDeployments === b.reserveDeployments && a.battles === b.battles;
}

function mesoPairKey(a: MesoRegionId, b: MesoRegionId): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function labelOffset(index: number): number {
  return ((index % 5) - 2) * 10;
}

function placeLabel(
  label: Container,
  anchor: { x: number; y: number },
  index: number,
  occupied: LabelRect[],
  worldWidth: number,
  worldHeight: number,
): void {
  const bounds = label.getLocalBounds();
  const width = bounds.width;
  const height = bounds.height;
  const gap = 8;
  const drift = labelOffset(index);
  const candidates = [
    { x: anchor.x + gap + drift, y: anchor.y + gap },
    { x: anchor.x + gap + drift, y: anchor.y - height - gap },
    { x: anchor.x - width - gap + drift, y: anchor.y + gap },
    { x: anchor.x - width - gap + drift, y: anchor.y - height - gap },
    { x: anchor.x + gap + drift, y: anchor.y + height + gap * 2 },
    { x: anchor.x - width - gap + drift, y: anchor.y + height + gap * 2 },
  ];
  let selected = candidates[0];
  for (const candidate of candidates) {
    const rect = clampLabelRect(candidate.x, candidate.y, width, height, worldWidth, worldHeight);
    selected = rect;
    if (!occupied.some((other) => rectsOverlap(rect, other, gap))) {
      break;
    }
  }
  const rect = clampLabelRect(selected.x, selected.y, width, height, worldWidth, worldHeight);
  label.position.set(rect.x, rect.y);
  occupied.push(rect);
}

function clampLabelRect(
  x: number,
  y: number,
  width: number,
  height: number,
  worldWidth: number,
  worldHeight: number,
): LabelRect {
  return {
    x: Math.max(4, Math.min(x, worldWidth - width - 4)),
    y: Math.max(4, Math.min(y, worldHeight - height - 4)),
    width,
    height,
  };
}

function rectsOverlap(a: LabelRect, b: LabelRect, gap: number): boolean {
  return a.x < b.x + b.width + gap && a.x + a.width + gap > b.x &&
    a.y < b.y + b.height + gap && a.y + a.height + gap > b.y;
}

function formatStrength(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function formatRatio(value: number): string {
  return value >= 10 ? value.toFixed(0) : value.toFixed(2).replace(/0$/, "").replace(/\.0$/, "");
}

function formatPriority(value: number | undefined): string {
  return value === undefined ? "-" : Math.round(value).toString();
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable);
}

function getSectorIdFromTarget(target: unknown): SectorId | null {
  let current = target as { name?: string | null; parent?: unknown } | null;
  while (current) {
    const name = current.name ?? "";
    for (const prefix of ["SectorDebugGeometry:", "SectorDebugLabel:"]) {
      if (name.startsWith(prefix)) {
        return name.slice(prefix.length) as SectorId;
      }
    }
    current = current.parent as typeof current;
  }
  return null;
}

function findSectorAtPoint(
  world: WorldState,
  point: Vec2,
  segmentIndex: ReadonlyMap<string, readonly Segment[]>,
  tolerance: number,
): SectorId | null {
  let closestFrontId: SectorId | null = null;
  let closestDistanceSquared = tolerance * tolerance;
  for (const front of world.landFronts.operationalSectors) {
    for (const edge of front.borderEdges) {
      const segments = segmentIndex.get(mesoPairKey(edge.regionAId, edge.regionBId));
      if (segments && segments.length > 0) {
        for (const segment of segments) {
          const distanceSquared = pointToSegmentDistanceSquared(point, segment);
          if (distanceSquared <= closestDistanceSquared) {
            closestDistanceSquared = distanceSquared;
            closestFrontId = front.id;
          }
        }
        continue;
      }
      const a = world.cache.mesoById.get(edge.regionAId)?.center;
      const b = world.cache.mesoById.get(edge.regionBId)?.center;
      if (!a || !b) continue;
      const distanceSquared = pointToSegmentDistanceSquared(point, { a, b });
      if (distanceSquared <= closestDistanceSquared) {
        closestDistanceSquared = distanceSquared;
        closestFrontId = front.id;
      }
    }
  }
  return closestFrontId;
}

function pointToSegmentDistanceSquared(point: Vec2, segment: Segment): number {
  const dx = segment.b.x - segment.a.x;
  const dy = segment.b.y - segment.a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    return (point.x - segment.a.x) ** 2 + (point.y - segment.a.y) ** 2;
  }
  const t = Math.max(0, Math.min(1,
    ((point.x - segment.a.x) * dx + (point.y - segment.a.y) * dy) / lengthSquared,
  ));
  const nearestX = segment.a.x + t * dx;
  const nearestY = segment.a.y + t * dy;
  return (point.x - nearestX) ** 2 + (point.y - nearestY) ** 2;
}
