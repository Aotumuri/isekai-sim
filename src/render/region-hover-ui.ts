import { Container, Graphics, Text, TextStyle } from "pixi.js";
import type { Vec2 } from "../utils/vector";
import type { MesoRegion } from "../worldgen/meso-region";
import type { MicroRegion } from "../worldgen/micro-region";
import type { WorldState } from "../sim/world-state";
import type { Renderer } from "./renderer";

const PANEL_BG = 0x0f1826;
const PANEL_BORDER = 0x1f2d43;
const PANEL_TEXT = 0xe6edf3;
const PANEL_ACCENT = 0x7aa2ff;
const PANEL_PADDING = 10;
const PANEL_OFFSET = 12;

const FONT_FAMILY = "Fira Sans, Noto Sans, Helvetica Neue, Helvetica, Arial, sans-serif";
const FONT_SIZE = 13;

interface RegionBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function attachRegionHoverUI(renderer: Renderer, world: WorldState): void {
  const uiLayer = new Container();
  uiLayer.name = "RegionHoverUI";
  renderer.uiContainer.addChild(uiLayer);

  const panel = new Container();
  const background = new Graphics();
  const textStyle = new TextStyle({
    fontFamily: FONT_FAMILY,
    fontSize: FONT_SIZE,
    fill: PANEL_TEXT,
    lineHeight: Math.round(FONT_SIZE * 1.4),
  });
  const text = new Text("", textStyle);
  text.resolution = renderer.app.renderer.resolution;
  panel.addChild(background);
  panel.addChild(text);
  panel.visible = false;
  uiLayer.addChild(panel);

  const boundsByIndex = world.microRegions.map((region) => computeBounds(region.polygon));
  const mesoById = new Map<string, MesoRegion>();
  for (const meso of world.mesoRegions) {
    mesoById.set(meso.id, meso);
  }

  let activeRegionId: string | null = null;
  let isSpacePressed = false;
  let lastPointerGlobal: Vec2 | null = null;

  const updatePanel = (screenPos: Vec2 | null): void => {
    if (!screenPos || !isSpacePressed) {
      panel.visible = false;
      return;
    }

    const worldPos = renderer.worldContainer.toLocal(screenPos);
    const region = findRegion(worldPos, world.microRegions, boundsByIndex);

    if (!region) {
      activeRegionId = null;
      panel.visible = false;
      return;
    }

    if (activeRegionId !== region.id) {
      activeRegionId = region.id;
      const meso = region.mesoRegionId ? mesoById.get(region.mesoRegionId) ?? null : null;
      text.text = buildRegionText(region, meso);
      layoutPanel(panel, background, text);
    }

    positionPanel(panel, renderer, screenPos);
    panel.visible = true;
  };

  renderer.app.stage.eventMode = "static";
  renderer.app.stage.hitArea = renderer.app.screen;
  renderer.app.stage.on("pointermove", (event) => {
    lastPointerGlobal = { x: event.global.x, y: event.global.y };
    updatePanel(lastPointerGlobal);
  });

  renderer.app.stage.on("pointerleave", () => {
    lastPointerGlobal = null;
    activeRegionId = null;
    panel.visible = false;
  });

  window.addEventListener("keydown", (event) => {
    if (event.code !== "Space") {
      return;
    }

    if (!isSpacePressed) {
      isSpacePressed = true;
      updatePanel(lastPointerGlobal);
    }

    event.preventDefault();
  });

  window.addEventListener("keyup", (event) => {
    if (event.code !== "Space") {
      return;
    }

    isSpacePressed = false;
    panel.visible = false;
    event.preventDefault();
  });

  window.addEventListener("blur", () => {
    isSpacePressed = false;
    panel.visible = false;
  });
}

function buildRegionText(region: MicroRegion, meso: MesoRegion | null): string {
  const terrain = region.isSea ? "Sea" : region.isRiver ? "River" : "Land";
  const elevation = region.elevation.toFixed(3);
  const mesoInfo = meso
    ? `Meso: ${meso.id} (${meso.type}, ${meso.microRegionIds.length})`
    : "Meso: -";

  return [
    `Micro: ${region.id}`,
    `Type: ${terrain}`,
    `Elevation: ${elevation}`,
    mesoInfo,
  ].join("\n");
}

function layoutPanel(panel: Container, background: Graphics, text: Text): void {
  const bounds = text.getLocalBounds();
  const width = bounds.width + PANEL_PADDING * 2;
  const height = bounds.height + PANEL_PADDING * 2;

  text.position.set(PANEL_PADDING, PANEL_PADDING);
  background.clear();
  background.beginFill(PANEL_BG, 0.94);
  background.lineStyle(1, PANEL_BORDER, 0.9);
  background.drawRoundedRect(0, 0, width, height, 8);
  background.endFill();
  background.lineStyle(1, PANEL_ACCENT, 0.8);
  background.moveTo(PANEL_PADDING, PANEL_PADDING + bounds.height + 4);
  background.lineTo(width - PANEL_PADDING, PANEL_PADDING + bounds.height + 4);

  panel.hitArea = null;
}

function positionPanel(panel: Container, renderer: Renderer, screenPos: Vec2): void {
  const bounds = panel.getLocalBounds();
  const desiredX = screenPos.x + PANEL_OFFSET;
  const desiredY = screenPos.y + PANEL_OFFSET;
  const maxX = renderer.app.screen.width - bounds.width - PANEL_OFFSET;
  const maxY = renderer.app.screen.height - bounds.height - PANEL_OFFSET;
  const x = Math.min(maxX, Math.max(PANEL_OFFSET, desiredX));
  const y = Math.min(maxY, Math.max(PANEL_OFFSET, desiredY));
  panel.position.set(x, y);
}

function findRegion(
  point: Vec2,
  microRegions: MicroRegion[],
  boundsByIndex: RegionBounds[],
): MicroRegion | null {
  for (let i = 0; i < microRegions.length; i += 1) {
    const bounds = boundsByIndex[i];
    if (
      point.x < bounds.minX ||
      point.x > bounds.maxX ||
      point.y < bounds.minY ||
      point.y > bounds.maxY
    ) {
      continue;
    }

    if (pointInPolygon(point, microRegions[i].polygon)) {
      return microRegions[i];
    }
  }

  return null;
}

function computeBounds(polygon: Vec2[]): RegionBounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of polygon) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }

  return { minX, minY, maxX, maxY };
}

function pointInPolygon(point: Vec2, polygon: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const intersect =
      (yi > point.y) !== (yj > point.y) &&
      point.x < ((xj - xi) * (point.y - yi)) / (yj - yi + Number.EPSILON) + xi;
    if (intersect) {
      inside = !inside;
    }
  }
  return inside;
}
