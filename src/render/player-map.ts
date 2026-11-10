import { getPlayerNation } from "../sim/player-nation";
import { createAgricultureOverlay } from "./agriculture-overlay";
import { getPopulationMapStyle, isPopulationMode } from "./population-map";
import { Container, Graphics, Text, TextStyle, Rectangle, WRAP_MODES } from "pixi.js";
import type { WorldState } from "../sim/world-state";
import type { MesoRegionId } from "../worldgen/meso-region";
import type { MicroRegion } from "../worldgen/micro-region";
import type { NationId } from "../worldgen/nation";
import { getNationName } from "../sim/nation-identity";
import { getNationFaction } from "../sim/factions";
import { getSubjectOverlord } from "../sim/subject-governments";
import { clearLayer } from "./clear-layer";
import { findSharedSegments, type Segment } from "./meso-border-geometry";
import { getNationColor } from "./nation-color";
import { CLAIM_COLORS, getClaimColor, getMapClaims } from "./claim-map-data";
import { getMapView } from "./map-view-state";
import { classifyPoliticalBoundary, getNationLabelAnchors, getPoliticalFill, getPlayerOccupations, SUBJECT_MAP_MARKER } from "./political-map-data";
import type { Renderer } from "./renderer";

export function attachPlayerMap(renderer: Renderer, world: WorldState): { update: () => void } {
  const layer = renderer.worldLayers.layers.PlayerMap;
  const fills = new Map<NationId, Graphics>(), borders = new Map<NationId, Graphics>();
  const outlines = new Map<NationId, Segment[]>();
  const labels = new Container(), selection = new Graphics(), parcelSelection = new Graphics();
  const districtOutlines = new Map<MesoRegionId, Segment[]>();
  let geometryKey = "", colorKey = "", labelKey = "", lastZoom = -1, occupationKey = "";
  let claimKey = "", claimLayer = new Container(), demandOutline = new Graphics();
  const claimEntries = new Map<MesoRegionId, Graphics>();
  let agriculture: Graphics | undefined;
  let populationLayer = new Container(), populationKey = "";
  const populationEntries = new Map<MesoRegionId, Graphics>();
  const populationDots = new Map<MesoRegionId, Graphics>();
  let occupationLayer = new Container();
  const occupationEntries = new Map<MesoRegionId, Graphics>();
  const microByMeso = new Map<MesoRegionId, MicroRegion[]>();
  const hatchTile = new Graphics();
  hatchTile.lineStyle(3, 0xffffff, 1);
  for (const x of [-16, 0, 16]) { hatchTile.moveTo(x, 0); hatchTile.lineTo(x + 16, 16); }
  const hatchTexture = renderer.app.renderer.generateTexture(hatchTile, { region: new Rectangle(0, 0, 16, 16), resolution: 1 });
  hatchTexture.baseTexture.wrapMode = WRAP_MODES.REPEAT;
  hatchTile.destroy();
  const dotTile = new Graphics();
  dotTile.beginFill(0xffffff);
  dotTile.drawCircle(4, 4, 2.6);
  dotTile.drawCircle(12, 12, 2.6);
  dotTile.endFill();
  const dotTexture = renderer.app.renderer.generateTexture(dotTile, { region: new Rectangle(0, 0, 16, 16), resolution: 1 });
  dotTexture.baseTexture.wrapMode = WRAP_MODES.REPEAT;
  dotTile.destroy();
  const polygons = (graphics: Graphics, polygon: { x: number; y: number }[]) => {
    if (!polygon.length) return;
    graphics.moveTo(polygon[0]!.x, polygon[0]!.y);
    for (const point of polygon.slice(1)) graphics.lineTo(point.x, point.y);
    graphics.closePath();
  };
  const stroke = (graphics: Graphics, segments: readonly Segment[]) => {
    for (const segment of segments) { graphics.moveTo(segment.a.x, segment.a.y); graphics.lineTo(segment.b.x, segment.b.y); }
  };
  const rebuild = () => {
    if (agriculture?.parent === layer) layer.removeChild(agriculture);
    clearLayer(layer); fills.clear(); borders.clear(); outlines.clear(); occupationEntries.clear(); microByMeso.clear(); districtOutlines.clear();
    populationLayer = new Container(); populationKey = ""; populationEntries.clear(); populationDots.clear();
    occupationLayer = new Container(); occupationKey = "";
    claimLayer = new Container(); demandOutline = new Graphics(); claimEntries.clear(); claimKey = "";
    // clearLayer destroys children; replace the two reusable overlay containers below.
    const provinces = new Graphics(), districts = new Graphics(), ocean = new Graphics();
    const ridgeFills = [0x153348, 0x193950, 0x1d3f57, 0x24475e].map((color) => {
      const graphics = new Graphics();
      graphics.beginFill(color, 0.94);
      return graphics;
    });
    const ownerByMeso = new Map(world.macroRegions.flatMap((macro) => macro.mesoRegionIds.map((id) => [id, macro.nationId] as const)));
    const provinceByMeso = new Map(world.macroRegions.flatMap((macro) => macro.mesoRegionIds.map((id) => [id, macro.id] as const)));
    const microById = new Map(world.microRegions.map((region) => [region.id, region]));
    ocean.beginFill(0x132f46, 0.94);
    provinces.lineStyle(0.8, 0xe5f1f6, 0.2); districts.lineStyle(0.7, 0x142536, 0.32);
    for (const nation of world.nations) {
      const fill = new Graphics(); fill.beginFill(0xffffff, 0.62); fills.set(nation.id, fill);
      const border = new Graphics(); border.lineStyle(2.2, 0xffffff, 1); border.tint = getNationColor(nation.id, world); borders.set(nation.id, border);
    }
    for (const region of world.microRegions) {
      if (region.mesoRegionId) {
        const list = microByMeso.get(region.mesoRegionId) ?? [];
        list.push(region); microByMeso.set(region.mesoRegionId, list);
      }
      const owner = region.mesoRegionId ? ownerByMeso.get(region.mesoRegionId) : undefined;
      const fill = owner ? fills.get(owner) : undefined;
      const ridgeFill = region.isSea && region.seaRidge
        ? ridgeFills[Math.min(ridgeFills.length - 1, Math.floor(region.seaRidge * ridgeFills.length))]
        : undefined;
      polygons(fill ?? ridgeFill ?? ocean, region.polygon);
      for (const neighborId of region.neighbors) {
        if (region.id >= neighborId) continue;
        const neighbor = microById.get(neighborId); if (!neighbor) continue;
        const otherOwner = neighbor.mesoRegionId ? ownerByMeso.get(neighbor.mesoRegionId) : undefined;
        const kind = classifyPoliticalBoundary(owner, region.mesoRegionId ? provinceByMeso.get(region.mesoRegionId) : undefined,
          otherOwner, neighbor.mesoRegionId ? provinceByMeso.get(neighbor.mesoRegionId) : undefined);
        if (kind === "none" && !(owner && otherOwner && region.mesoRegionId !== neighbor.mesoRegionId)) continue;
        const segments = findSharedSegments(region, neighbor);
        if (region.mesoRegionId !== neighbor.mesoRegionId) for (const id of [region.mesoRegionId, neighbor.mesoRegionId]) if (id) {
          const list = districtOutlines.get(id) ?? []; list.push(...segments); districtOutlines.set(id, list);
        }
        if (kind === "national") {
          for (const id of [owner, otherOwner]) if (id) { const list = outlines.get(id) ?? []; list.push(...segments); outlines.set(id, list); }
          if (owner) stroke(borders.get(owner)!, segments); if (otherOwner) stroke(borders.get(otherOwner)!, segments); }
        else if (kind === "province") stroke(provinces, segments);
        else stroke(districts, segments);
      }
    }
    ocean.endFill(); layer.addChild(ocean);
    for (const fill of ridgeFills) { fill.endFill(); layer.addChild(fill); }
    for (const fill of fills.values()) { fill.endFill(); layer.addChild(fill); }
    layer.addChild(populationLayer, claimLayer, occupationLayer);
    if (agriculture) layer.addChildAt(agriculture, layer.getChildIndex(claimLayer));
    provinces.name = "PlayerProvinces"; districts.name = "PlayerDistricts";
    layer.addChild(provinces, districts);
    for (const border of borders.values()) layer.addChild(border);
    layer.addChild(demandOutline);
    // Labels live in a separate layer so geometry rebuilds cannot destroy them.
    colorKey = ""; labelKey = "";
  };
  renderer.worldLayers.layers.NationLabels.addChild(labels, selection, parcelSelection);
  const update = () => {
    const view = getMapView(world), debug = view.mode === "debug";
    layer.visible = !debug && view.mode !== "terrain"; renderer.worldLayers.layers.NationLabels.visible = true; labels.visible = !debug && view.labels;
    renderer.worldLayers.layers.NationFill.visible = debug;
    renderer.worldLayers.layers.MesoBorder.visible = debug;
    renderer.worldLayers.layers.TerritoryEffects.visible = debug;
    const nextGeometry = `${world.mapVersion}:${world.territoryVersion}`;
    if (nextGeometry !== geometryKey) { geometryKey = nextGeometry; rebuild(); }
    if (view.farmland && !agriculture) {
      agriculture = createAgricultureOverlay(world);
      layer.addChildAt(agriculture, layer.getChildIndex(claimLayer));
    }
    if (agriculture) agriculture.visible = !!view.farmland;
    const populationMode = isPopulationMode(view.mode) ? view.mode : null;
    populationLayer.visible = populationMode !== null;
    if (populationMode) {
      const key = `${populationMode}:${world.populationRevision ?? 0}`;
      if (key !== populationKey) {
        populationKey = key;
        for (const [id, microRegions] of microByMeso) {
          const style = getPopulationMapStyle(world, id, populationMode);
          if (!style) continue;
          let graphic = populationEntries.get(id);
          if (!graphic) {
            graphic = new Graphics(); graphic.beginFill(0xffffff);
            for (const micro of microRegions) polygons(graphic, micro.polygon);
            graphic.endFill(); populationEntries.set(id, graphic); populationLayer.addChild(graphic);
          }
          graphic.tint = style.color; graphic.alpha = style.alpha;
          let dots = populationDots.get(id);
          if (!dots && style.secondaryColor !== undefined) {
            dots = new Graphics(); dots.beginTextureFill({ texture: dotTexture });
            for (const micro of microRegions) polygons(dots, micro.polygon);
            dots.endFill(); populationDots.set(id, dots); populationLayer.addChild(dots);
          }
          if (dots) {
            dots.visible = style.secondaryColor !== undefined;
            dots.tint = style.secondaryColor ?? 0xffffff;
          }
        }
      }
    }
    claimLayer.visible = demandOutline.visible = view.mode === "claims";
    if (view.mode === "claims" && view.selectedNationId) {
      const nextClaims = `${geometryKey}:${view.revision}:${world.territorialClaims?.version}:${world.time.slowTick}:${JSON.stringify([...(world.diplomacy?.relations.values() ?? [])].filter((r) => r.crisis?.aggressorId === view.selectedNationId).map((r) => r.crisis))}`;
      if (nextClaims !== claimKey) {
        const claims = getMapClaims(world, view.selectedNationId);
        claimKey = nextClaims; demandOutline.clear(); demandOutline.lineStyle(3, CLAIM_COLORS.demand, 1);
        const live = new Set(claims.map((entry) => entry.regionId));
        for (const [id, graphics] of claimEntries) if (!live.has(id)) {
          claimLayer.removeChild(graphics); graphics.destroy(); claimEntries.delete(id);
        }
        for (const entry of claims) {
          let graphics = claimEntries.get(entry.regionId);
          if (!graphics) {
            graphics = new Graphics(); graphics.beginFill(0xffffff, 0.92);
            for (const micro of microByMeso.get(entry.regionId) ?? []) polygons(graphics, micro.polygon);
            graphics.endFill(); claimEntries.set(entry.regionId, graphics); claimLayer.addChild(graphics);
          }
          graphics.tint = getClaimColor(entry.strength);
          if (entry.demanded) stroke(demandOutline, districtOutlines.get(entry.regionId) ?? []);
        }
      }
    }
    occupationLayer.visible = view.occupations;
    const subjectRevision = world.militaryAccess?.version ?? 0;
    const nextOccupations = `${geometryKey}:${world.occupation.version}:${view.revision}:${view.mode === "diplomacy" ? world.time.slowTick : 0}:${world.factions?.version ?? 0}:${subjectRevision}`;
    if (view.occupations && nextOccupations !== occupationKey) {
      occupationKey = nextOccupations;
      const current = getPlayerOccupations(world), live = new Set(current.map((entry) => entry.regionId));
      for (const [id, graphics] of occupationEntries) if (!live.has(id)) {
        occupationLayer.removeChild(graphics); graphics.destroy(); occupationEntries.delete(id);
      }
      for (const entry of current) {
        let graphics = occupationEntries.get(entry.regionId);
        if (!graphics) {
          graphics = new Graphics();
          graphics.beginFill(0xffffff, 0.4);
          for (const micro of microByMeso.get(entry.regionId) ?? []) polygons(graphics, micro.polygon);
          graphics.endFill();
          graphics.beginTextureFill({ texture: hatchTexture, color: 0xffffff, alpha: 0.95 });
          for (const micro of microByMeso.get(entry.regionId) ?? []) polygons(graphics, micro.polygon);
          graphics.endFill(); occupationEntries.set(entry.regionId, graphics); occupationLayer.addChild(graphics);
        }
        graphics.tint = getPoliticalFill(world, entry.occupierId);
      }
    }
    (layer.getChildByName("PlayerProvinces") as Graphics).visible = view.provinceBorders;
    (layer.getChildByName("PlayerDistricts") as Graphics).visible = view.districtBorders;
    const nextColors = `${nextGeometry}:${view.revision}:${world.time.slowTick}:${world.factions?.version ?? 0}:${subjectRevision}`;
    if (nextColors !== colorKey) {
      colorKey = nextColors;
      for (const [id, fill] of fills) { fill.tint = getPoliticalFill(world, id); fill.alpha = id === view.selectedNationId ? 1 : 0.92; }
    }
    const nextLabels = `${nextGeometry}:${view.revision}:${world.factions?.version ?? 0}:${subjectRevision}`;
    const labelsChanged = nextLabels !== labelKey;
    if (labelsChanged) {
      labelKey = nextLabels; clearLayer(labels); selection.clear(); parcelSelection.clear();
      const preview = new Set(view.territoryPreviewIds ?? []);
      parcelSelection.beginFill(0xffd35c, 0.38);
      for (const id of preview) for (const micro of microByMeso.get(id) ?? []) polygons(parcelSelection, micro.polygon);
      parcelSelection.endFill(); parcelSelection.lineStyle(2.4, 0xffdb73, 1);
      for (const id of preview) stroke(parcelSelection, districtOutlines.get(id) ?? []);
      if (view.selectedNationId) { selection.lineStyle(3.2, 0xfff5cf, 0.95); stroke(selection, outlines.get(view.selectedNationId) ?? []); }
      if (view.targetNationId && getPlayerNation(world)) {
        selection.lineStyle(3.2, 0x83d8ff, 0.95);
        stroke(selection, outlines.get(view.targetNationId) ?? []);
      }
      for (const anchor of getNationLabelAnchors(world)) {
        const faction = getNationFaction(world, anchor.nationId);
        const subject = getSubjectOverlord(world, anchor.nationId);
        const name = getNationName(world, anchor.nationId, "short");
        const text = (subject ? `${SUBJECT_MAP_MARKER} ${name}` : name) + (view.mode === "factions" ? `\n${faction?.name ?? "Non-aligned"}` : "");
        const label = new Text(text, new TextStyle({ fontFamily: "Georgia, serif", fontSize: anchor.primary ? Math.min(22, 13 + Math.sqrt(anchor.regionCount) * 0.8) : 12,
          fontWeight: "600", fill: 0xf4f5ee, align: "center", stroke: 0x132237, strokeThickness: 3, letterSpacing: 0.7, dropShadow: true, dropShadowAlpha: 0.35, dropShadowDistance: 1 }));
        label.anchor.set(0.5);
        const halfWidth = label.width / 2 + 8, halfHeight = label.height / 2 + 8;
        label.position.set(Math.max(halfWidth, Math.min(world.width - halfWidth, anchor.x)), Math.max(halfHeight, Math.min(world.height - halfHeight, anchor.y)));
        label.resolution = 2;
        label.eventMode = "none"; label.alpha = anchor.nationId === view.selectedNationId ? 1 : 0.92;
        labels.addChild(label);
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
