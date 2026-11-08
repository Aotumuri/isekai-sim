import { Container, Graphics, Text, TextStyle } from "pixi.js";
import type { WorldState } from "../sim/world-state";
import type { NationId } from "../worldgen/nation";
import { getNationName } from "../sim/nation-identity";
import { getNationFaction } from "../sim/factions";
import { clearLayer } from "./clear-layer";
import { findSharedSegments, type Segment } from "./meso-border-geometry";
import { getNationColor } from "./nation-color";
import { getMapView } from "./map-view-state";
import { classifyPoliticalBoundary, getNationLabelAnchors, getPoliticalFill } from "./political-map-data";
import type { Renderer } from "./renderer";

export function attachPlayerMap(renderer: Renderer, world: WorldState): { update: () => void } {
  const layer = renderer.worldLayers.layers.PlayerMap;
  const fills = new Map<NationId, Graphics>(), borders = new Map<NationId, Graphics>();
  const outlines = new Map<NationId, Segment[]>();
  const labels = new Container(), selection = new Graphics();
  let geometryKey = "", colorKey = "", labelKey = "", lastZoom = -1;
  const polygons = (graphics: Graphics, polygon: { x: number; y: number }[]) => {
    if (!polygon.length) return;
    graphics.moveTo(polygon[0]!.x, polygon[0]!.y);
    for (const point of polygon.slice(1)) graphics.lineTo(point.x, point.y);
    graphics.closePath();
  };
  const stroke = (graphics: Graphics, segments: Segment[]) => {
    for (const segment of segments) { graphics.moveTo(segment.a.x, segment.a.y); graphics.lineTo(segment.b.x, segment.b.y); }
  };
  const rebuild = () => {
    clearLayer(layer); fills.clear(); borders.clear(); outlines.clear();
    // clearLayer destroys children; replace the two reusable overlay containers below.
    const provinces = new Graphics(), districts = new Graphics(), ocean = new Graphics();
    const ownerByMeso = new Map(world.macroRegions.flatMap((macro) => macro.mesoRegionIds.map((id) => [id, macro.nationId] as const)));
    const provinceByMeso = new Map(world.macroRegions.flatMap((macro) => macro.mesoRegionIds.map((id) => [id, macro.id] as const)));
    const microById = new Map(world.microRegions.map((region) => [region.id, region]));
    ocean.beginFill(0x132f46, 0.94);
    provinces.lineStyle(0.8, 0xe5f1f6, 0.2); districts.lineStyle(0.7, 0x142536, 0.32);
    for (const nation of world.nations) {
      const fill = new Graphics(); fill.beginFill(0xffffff, 0.62); fills.set(nation.id, fill);
      const border = new Graphics(); border.lineStyle(2.2, 0xffffff, 1); border.tint = getNationColor(nation.id); borders.set(nation.id, border);
    }
    for (const region of world.microRegions) {
      const owner = region.mesoRegionId ? ownerByMeso.get(region.mesoRegionId) : undefined;
      const fill = owner ? fills.get(owner) : undefined;
      polygons(fill ?? ocean, region.polygon);
      for (const neighborId of region.neighbors) {
        if (region.id >= neighborId) continue;
        const neighbor = microById.get(neighborId); if (!neighbor) continue;
        const otherOwner = neighbor.mesoRegionId ? ownerByMeso.get(neighbor.mesoRegionId) : undefined;
        const kind = classifyPoliticalBoundary(owner, region.mesoRegionId ? provinceByMeso.get(region.mesoRegionId) : undefined,
          otherOwner, neighbor.mesoRegionId ? provinceByMeso.get(neighbor.mesoRegionId) : undefined);
        if (kind === "none" && !(owner && otherOwner && region.mesoRegionId !== neighbor.mesoRegionId)) continue;
        const segments = findSharedSegments(region, neighbor);
        if (kind === "national") {
          for (const id of [owner, otherOwner]) if (id) { const list = outlines.get(id) ?? []; list.push(...segments); outlines.set(id, list); }
          if (owner) stroke(borders.get(owner)!, segments); if (otherOwner) stroke(borders.get(otherOwner)!, segments); }
        else if (kind === "province") stroke(provinces, segments);
        else stroke(districts, segments);
      }
    }
    ocean.endFill(); layer.addChild(ocean);
    for (const fill of fills.values()) { fill.endFill(); layer.addChild(fill); }
    provinces.name = "PlayerProvinces"; districts.name = "PlayerDistricts";
    layer.addChild(provinces, districts);
    for (const border of borders.values()) layer.addChild(border);
    // Labels live in a separate layer so geometry rebuilds cannot destroy them.
    colorKey = ""; labelKey = "";
  };
  renderer.worldLayers.layers.NationLabels.addChild(labels, selection);
  const update = () => {
    const view = getMapView(world), debug = view.mode === "debug";
    layer.visible = !debug; renderer.worldLayers.layers.NationLabels.visible = true; labels.visible = !debug && view.labels;
    renderer.worldLayers.layers.NationFill.visible = debug;
    renderer.worldLayers.layers.MesoBorder.visible = debug;
    renderer.worldLayers.layers.TerritoryEffects.visible = debug;
    const nextGeometry = `${world.mapVersion}:${world.territoryVersion}`;
    if (nextGeometry !== geometryKey) { geometryKey = nextGeometry; rebuild(); }
    (layer.getChildByName("PlayerProvinces") as Graphics).visible = view.provinceBorders;
    (layer.getChildByName("PlayerDistricts") as Graphics).visible = view.districtBorders;
    const nextColors = `${nextGeometry}:${view.revision}:${world.time.slowTick}:${world.factions?.version ?? 0}`;
    if (nextColors !== colorKey) {
      colorKey = nextColors;
      for (const [id, fill] of fills) { fill.tint = getPoliticalFill(world, id); fill.alpha = id === view.selectedNationId ? 1 : 0.92; }
    }
    const nextLabels = `${nextGeometry}:${view.revision}:${world.factions?.version ?? 0}`;
    const labelsChanged = nextLabels !== labelKey;
    if (labelsChanged) {
      labelKey = nextLabels; clearLayer(labels); selection.clear();
      if (view.selectedNationId) { selection.lineStyle(3.2, 0xfff5cf, 0.95); stroke(selection, outlines.get(view.selectedNationId) ?? []); }
      for (const anchor of getNationLabelAnchors(world)) {
        const faction = getNationFaction(world, anchor.nationId);
        const text = getNationName(world, anchor.nationId) + (view.mode === "factions" ? `\n${faction?.name ?? "Non-aligned"}` : "");
        const label = new Text(text, new TextStyle({ fontFamily: "Georgia, serif", fontSize: anchor.primary ? Math.min(22, 13 + Math.sqrt(anchor.regionCount) * 0.8) : 12,
          fontWeight: "600", fill: 0xf4f5ee, align: "center", stroke: 0x132237, strokeThickness: 3, letterSpacing: 0.7, dropShadow: true, dropShadowAlpha: 0.35, dropShadowDistance: 1 }));
        label.anchor.set(0.5);
        const halfWidth = label.width / 2 + 8, halfHeight = label.height / 2 + 8;
        label.position.set(Math.max(halfWidth, Math.min(world.width - halfWidth, anchor.x)), Math.max(halfHeight, Math.min(world.height - halfHeight, anchor.y)));
        label.resolution = 2;
        label.eventMode = "none"; label.alpha = anchor.nationId === view.selectedNationId ? 1 : 0.92;
        labels.addChild(label);
        if (anchor.primary && anchor.nationId === view.selectedNationId) {
          selection.lineStyle(1.5, 0xffffff, 0.9); selection.drawCircle(anchor.x, anchor.y, 5);
        }
      }
    }
    const zoom = renderer.worldContainer.scale.x;
    if (zoom !== lastZoom || labelsChanged) {
      lastZoom = zoom;
      for (const label of labels.children) label.scale.set(Math.max(0.6, Math.min(1.4, 1 / zoom)));
    }
  };
  return { update };
}
