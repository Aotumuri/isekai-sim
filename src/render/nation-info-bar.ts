import { Container, Graphics, Text, TextStyle, type FederatedPointerEvent } from "pixi.js";
import { WORLD_BALANCE } from "../data/balance";
import type { NationRuntime } from "../sim/nation-runtime";
import type { UnitState } from "../sim/unit";
import type { WorldState } from "../sim/world-state";
import type { Vec2 } from "../utils/vector";
import type { MacroRegion } from "../worldgen/macro-region";
import type { MesoRegion, MesoRegionId } from "../worldgen/meso-region";
import type { NationId } from "../worldgen/nation";
import type { Renderer } from "./renderer";
import { buildRegionBounds, findRegion } from "./region/hit-test";

const PANEL_BG = 0x0f1826;
const PANEL_BORDER = 0x1f2d43;
const PANEL_TEXT = 0xe6edf3;
const PANEL_MUTED = 0x93a4bf;
const PANEL_ACCENT = 0x7aa2ff;
const PANEL_MARGIN = 12;
const PANEL_PADDING = 12;
const PANEL_WIDTH = 300;
const ROW_GAP = 4;
const SECTION_GAP = 8;
const BAR_HEIGHT = 6;
const BAR_RADIUS = 4;
const UPDATE_INTERVAL_MS = 1000;

const TAB_BG = 0x111c2e;
const TAB_BORDER = 0x22324d;
const TAB_TEXT = 0xc7d2e7;
const TAB_WIDTH = 36;
const TAB_HEIGHT = 120;

const SIDEBAR_BG = 0x0b121d;
const SIDEBAR_BORDER = 0x1a263a;
const SIDEBAR_EXPANDED_WIDTH = PANEL_WIDTH + PANEL_MARGIN * 2 + TAB_WIDTH;
const SIDEBAR_COLLAPSED_WIDTH = TAB_WIDTH + PANEL_MARGIN * 2;

const FONT_FAMILY = "Fira Sans, Noto Sans, Helvetica Neue, Helvetica, Arial, sans-serif";
const FONT_SIZE = 12;

interface StatRow {
  label: Text;
  value: Text;
}

export interface NationInfoBar {
  update: () => void;
}

export function attachNationInfoBar(renderer: Renderer, world: WorldState): NationInfoBar {
  const existingRoot = renderer.uiContainer.getChildByName("NationInfoBar");
  if (existingRoot) {
    renderer.uiContainer.removeChild(existingRoot);
    existingRoot.destroy({ children: true });
  }
  for (const child of renderer.app.stage.children.slice()) {
    if (child.name === "WorldMask") {
      renderer.app.stage.removeChild(child);
      child.destroy({ children: true });
    }
  }
  renderer.app.stage.removeAllListeners("pointertap");

  const root = new Container();
  root.name = "NationInfoBar";
  renderer.uiContainer.addChild(root);

  const panelContent = new Container();
  panelContent.name = "NationInfoPanel";
  const sidebarBg = new Graphics();
  sidebarBg.name = "NationInfoSidebar";
  const background = new Graphics();
  const titleStyle = new TextStyle({
    fontFamily: FONT_FAMILY,
    fontSize: 15,
    fill: PANEL_ACCENT,
    fontWeight: "600",
  });
  const nameStyle = new TextStyle({
    fontFamily: FONT_FAMILY,
    fontSize: 14,
    fill: PANEL_TEXT,
  });
  const sectionStyle = new TextStyle({
    fontFamily: FONT_FAMILY,
    fontSize: 11,
    fill: PANEL_MUTED,
    fontWeight: "600",
    letterSpacing: 0.5,
  });
  const labelStyle = new TextStyle({
    fontFamily: FONT_FAMILY,
    fontSize: FONT_SIZE,
    fill: PANEL_MUTED,
  });
  const valueStyle = new TextStyle({
    fontFamily: FONT_FAMILY,
    fontSize: FONT_SIZE,
    fill: PANEL_TEXT,
  });

  const titleText = new Text("Nation", titleStyle);
  const nameText = new Text("Select a nation", nameStyle);
  const overviewLabel = new Text("OVERVIEW", sectionStyle);
  const resourcesLabel = new Text("RESOURCES", sectionStyle);
  const supportLabel = new Text("WAR SUPPORT", sectionStyle);
  const surrenderLabel = new Text("SURRENDER", sectionStyle);
  titleText.resolution = renderer.app.renderer.resolution;
  nameText.resolution = renderer.app.renderer.resolution;
  overviewLabel.resolution = renderer.app.renderer.resolution;
  resourcesLabel.resolution = renderer.app.renderer.resolution;
  supportLabel.resolution = renderer.app.renderer.resolution;
  surrenderLabel.resolution = renderer.app.renderer.resolution;

  const overviewRows = {
    units: createRow("Units", "-", labelStyle, valueStyle, renderer),
    meso: createRow("Regions", "-", labelStyle, valueStyle, renderer),
    cities: createRow("Cities", "-", labelStyle, valueStyle, renderer),
    wars: createRow("Wars", "-", labelStyle, valueStyle, renderer),
  };
  const resourcesRows = {
    steel: createRow("Steel", "-", labelStyle, valueStyle, renderer),
    fuel: createRow("Fuel", "-", labelStyle, valueStyle, renderer),
    manpower: createRow("Manpower", "-", labelStyle, valueStyle, renderer),
    weapons: createRow("Weapons", "-", labelStyle, valueStyle, renderer),
  };
  const supportRows = {
    support: createRow("Support", "-", labelStyle, valueStyle, renderer),
    duration: createRow("Duration", "-", labelStyle, valueStyle, renderer),
    capital: createRow("Capital", "-", labelStyle, valueStyle, renderer),
    cityLoss: createRow("City Loss", "-", labelStyle, valueStyle, renderer),
    role: createRow("Role", "-", labelStyle, valueStyle, renderer),
    boost: createRow("Boost", "-", labelStyle, valueStyle, renderer),
  };
  const surrenderRows = {
    progress: createRow("Progress", "-", labelStyle, valueStyle, renderer),
    occupation: createRow("Occupation", "-", labelStyle, valueStyle, renderer),
    capital: createRow("Capital", "-", labelStyle, valueStyle, renderer),
    cityLoss: createRow("City Loss", "-", labelStyle, valueStyle, renderer),
    unitLoss: createRow("Unit Loss", "-", labelStyle, valueStyle, renderer),
    multiplier: createRow("Support Mult", "-", labelStyle, valueStyle, renderer),
  };

  const supportBarBg = new Graphics();
  const supportBarFill = new Graphics();
  const surrenderBarBg = new Graphics();
  const surrenderBarFill = new Graphics();

  panelContent.addChild(
    background,
    titleText,
    nameText,
    overviewLabel,
    resourcesLabel,
    supportLabel,
    surrenderLabel,
    supportBarBg,
    supportBarFill,
    surrenderBarBg,
    surrenderBarFill,
  );

  for (const row of Object.values(overviewRows)) {
    panelContent.addChild(row.label, row.value);
  }
  for (const row of Object.values(resourcesRows)) {
    panelContent.addChild(row.label, row.value);
  }
  for (const row of Object.values(supportRows)) {
    panelContent.addChild(row.label, row.value);
  }
  for (const row of Object.values(surrenderRows)) {
    panelContent.addChild(row.label, row.value);
  }

  const tabContainer = new Container();
  tabContainer.name = "NationInfoTab";
  tabContainer.eventMode = "static";
  tabContainer.cursor = "pointer";
  const tabBg = new Graphics();
  const tabTextStyle = new TextStyle({
    fontFamily: FONT_FAMILY,
    fontSize: 11,
    fill: TAB_TEXT,
    fontWeight: "600",
    letterSpacing: 1,
  });
  const tabText = new Text("NATION", tabTextStyle);
  tabText.resolution = renderer.app.renderer.resolution;
  tabText.anchor.set(0.5);
  tabText.angle = -90;
  tabContainer.addChild(tabBg, tabText);

  root.addChild(sidebarBg, panelContent, tabContainer);

  const worldMask = new Graphics();
  worldMask.name = "WorldMask";
  worldMask.renderable = false;
  renderer.app.stage.addChildAt(worldMask, 0);
  renderer.worldContainer.mask = worldMask;

  sidebarBg.eventMode = "static";
  sidebarBg.cursor = "default";
  sidebarBg.on("pointerdown", (event) => event.stopPropagation());
  sidebarBg.on("pointertap", (event) => event.stopPropagation());

  const boundsByIndex = buildRegionBounds(world.microRegions);
  const mesoById = new Map<MesoRegionId, MesoRegion>();
  for (const meso of world.mesoRegions) {
    mesoById.set(meso.id, meso);
  }

  let selectedNationId: NationId | null = null;
  let isExpanded = false;
  let lastUpdateMs = -Infinity;
  let lastScreenWidth = -1;
  let lastScreenHeight = -1;
  let lastPanelHeight = 0;
  let lastSidebarWidth = -1;
  let lastMaskWidth = -1;
  let lastMaskHeight = -1;
  let cachedTerritoryVersion = -1;
  let macroByMesoId = new Map<MesoRegionId, MacroRegion>();

  const ensureMacroIndex = (): void => {
    if (cachedTerritoryVersion === world.territoryVersion && macroByMesoId.size > 0) {
      return;
    }
    macroByMesoId = new Map<MesoRegionId, MacroRegion>();
    for (const macro of world.macroRegions) {
      for (const mesoId of macro.mesoRegionIds) {
        macroByMesoId.set(mesoId, macro);
      }
    }
    cachedTerritoryVersion = world.territoryVersion;
  };

  const selectNationFromScreen = (screenPos: Vec2): void => {
    const worldPos = renderer.worldContainer.toLocal(screenPos);
    const region = findRegion(worldPos, world.microRegions, boundsByIndex);
    if (!region || !region.mesoRegionId) {
      selectedNationId = null;
      lastUpdateMs = -Infinity;
      return;
    }
    ensureMacroIndex();
    const macro = macroByMesoId.get(region.mesoRegionId);
    if (!macro) {
      selectedNationId = null;
      lastUpdateMs = -Infinity;
      return;
    }
    selectedNationId = macro.nationId;
    lastUpdateMs = -Infinity;
  };

  renderer.app.stage.eventMode = "static";
  renderer.app.stage.hitArea = renderer.app.screen;

  const handleSelect = (event: { global: Vec2; button?: number }): void => {
    if (typeof event.button === "number" && event.button !== 0) {
      return;
    }
    const worldWidth = Math.max(0, renderer.app.screen.width - renderer.uiRightWidth);
    if (event.global.x > worldWidth) {
      return;
    }
    selectNationFromScreen({ x: event.global.x, y: event.global.y });
  };

  renderer.app.stage.on("pointertap", handleSelect);
  tabContainer.on("pointertap", (event: FederatedPointerEvent) => {
    event.stopPropagation();
    isExpanded = !isExpanded;
    lastUpdateMs = -Infinity;
    update(true);
  });

  const update = (force = false): void => {
    const now = renderer.app.ticker.lastTime;
    const screen = renderer.app.screen;
    const screenChanged = screen.width !== lastScreenWidth || screen.height !== lastScreenHeight;
    if (screenChanged) {
      lastScreenWidth = screen.width;
      lastScreenHeight = screen.height;
    }

    const sidebarWidth = computeSidebarWidth(screen.width, isExpanded);
    const worldWidth = Math.max(0, screen.width - sidebarWidth);
    renderer.uiRightWidth = sidebarWidth;

    if (
      screenChanged ||
      sidebarWidth !== lastSidebarWidth ||
      worldWidth !== lastMaskWidth ||
      screen.height !== lastMaskHeight
    ) {
      drawWorldMask(worldMask, worldWidth, screen.height);
      drawSidebarBg(sidebarBg, worldWidth, sidebarWidth, screen.height);
      lastSidebarWidth = sidebarWidth;
      lastMaskWidth = worldWidth;
      lastMaskHeight = screen.height;
    }

    if (!isExpanded) {
      panelContent.visible = false;
      layoutTab(
        tabBg,
        tabText,
        tabContainer,
        worldWidth,
        sidebarWidth,
        screen.height,
        false,
      );
      return;
    }

    panelContent.visible = true;
    const shouldRefresh = force || screenChanged || now - lastUpdateMs >= UPDATE_INTERVAL_MS;
    if (shouldRefresh) {
      lastUpdateMs = now;
      if (selectedNationId) {
        const nation = world.nations.find((entry) => entry.id === selectedNationId) ?? null;
        if (nation) {
          const stats = buildNationStats(world, nation, mesoById);
          nameText.text = stats.displayName;
          setRowValue(overviewRows.units, `${stats.unitCount}`);
          setRowValue(overviewRows.meso, `${stats.mesoCount}`);
          setRowValue(overviewRows.cities, `${stats.cityCount}`);
          setRowValue(overviewRows.wars, `${stats.warCount}`);

          setRowValue(resourcesRows.steel, formatInteger(stats.resources.steel));
          setRowValue(resourcesRows.fuel, formatInteger(stats.resources.fuel));
          setRowValue(resourcesRows.manpower, formatInteger(stats.resources.manpower));
          setRowValue(resourcesRows.weapons, formatInteger(stats.resources.weapons));

          setRowValue(supportRows.support, formatPercent(stats.warSupport));
          setRowValue(supportRows.duration, formatNumber(stats.supportDuration));
          setRowValue(supportRows.capital, formatNumber(stats.supportCapital));
          setRowValue(supportRows.cityLoss, formatNumber(stats.supportCityLoss));
          setRowValue(supportRows.role, `x${formatNumber(stats.supportRoleMult)}`);
          setRowValue(supportRows.boost, `+${formatNumber(stats.supportBoost)}`);

          setRowValue(
            surrenderRows.progress,
            `${formatNumber(stats.surrenderScore)}/${formatNumber(stats.surrenderThreshold)}`,
          );
          setRowValue(surrenderRows.occupation, formatNumber(stats.surrenderOccupation));
          setRowValue(surrenderRows.capital, formatNumber(stats.surrenderCapital));
          setRowValue(surrenderRows.cityLoss, formatNumber(stats.surrenderCityLoss));
          setRowValue(surrenderRows.unitLoss, formatNumber(stats.surrenderUnitLoss));
          setRowValue(
            surrenderRows.multiplier,
            `x${formatNumber(stats.surrenderMultiplier)}`,
          );

          lastPanelHeight = layoutPanel(
            panelContent,
            background,
            titleText,
            nameText,
            overviewLabel,
            resourcesLabel,
            supportLabel,
            surrenderLabel,
            overviewRows,
            resourcesRows,
            supportRows,
            surrenderRows,
            supportBarBg,
            supportBarFill,
            surrenderBarBg,
            surrenderBarFill,
            stats.warSupport,
            stats.surrenderRatio,
          );
        } else {
          selectedNationId = null;
          lastPanelHeight = layoutEmptyPanel(
            panelContent,
            background,
            titleText,
            nameText,
            overviewLabel,
            resourcesLabel,
            supportLabel,
            surrenderLabel,
            overviewRows,
            resourcesRows,
            supportRows,
            surrenderRows,
            supportBarBg,
            supportBarFill,
            surrenderBarBg,
            surrenderBarFill,
          );
        }
      } else {
        lastPanelHeight = layoutEmptyPanel(
          panelContent,
          background,
          titleText,
          nameText,
          overviewLabel,
          resourcesLabel,
          supportLabel,
          surrenderLabel,
          overviewRows,
          resourcesRows,
          supportRows,
          surrenderRows,
          supportBarBg,
          supportBarFill,
          surrenderBarBg,
          surrenderBarFill,
        );
      }
    }

    positionPanel(panelContent, worldWidth);
    layoutTab(
      tabBg,
      tabText,
      tabContainer,
      worldWidth,
      sidebarWidth,
      screen.height,
      true,
    );
  };

  update(true);

  return { update: () => update(false) };
}

function createRow(
  label: string,
  value: string,
  labelStyle: TextStyle,
  valueStyle: TextStyle,
  renderer: Renderer,
): StatRow {
  const labelText = new Text(label, labelStyle);
  const valueText = new Text(value, valueStyle);
  labelText.resolution = renderer.app.renderer.resolution;
  valueText.resolution = renderer.app.renderer.resolution;
  return { label: labelText, value: valueText };
}

function setRowValue(row: StatRow, value: string): void {
  row.value.text = value;
}

function layoutEmptyPanel(
  panelContent: Container,
  background: Graphics,
  titleText: Text,
  nameText: Text,
  overviewLabel: Text,
  resourcesLabel: Text,
  supportLabel: Text,
  surrenderLabel: Text,
  overviewRows: Record<string, StatRow>,
  resourcesRows: Record<string, StatRow>,
  supportRows: Record<string, StatRow>,
  surrenderRows: Record<string, StatRow>,
  supportBarBg: Graphics,
  supportBarFill: Graphics,
  surrenderBarBg: Graphics,
  surrenderBarFill: Graphics,
): number {
  nameText.text = "Select a nation";
  for (const row of Object.values(overviewRows)) {
    setRowValue(row, "-");
  }
  for (const row of Object.values(resourcesRows)) {
    setRowValue(row, "-");
  }
  for (const row of Object.values(supportRows)) {
    setRowValue(row, "-");
  }
  for (const row of Object.values(surrenderRows)) {
    setRowValue(row, "-");
  }
  return layoutPanel(
    panelContent,
    background,
    titleText,
    nameText,
    overviewLabel,
    resourcesLabel,
    supportLabel,
    surrenderLabel,
    overviewRows,
    resourcesRows,
    supportRows,
    surrenderRows,
    supportBarBg,
    supportBarFill,
    surrenderBarBg,
    surrenderBarFill,
    0,
    0,
  );
}

function layoutPanel(
  panelContent: Container,
  background: Graphics,
  titleText: Text,
  nameText: Text,
  overviewLabel: Text,
  resourcesLabel: Text,
  supportLabel: Text,
  surrenderLabel: Text,
  overviewRows: Record<string, StatRow>,
  resourcesRows: Record<string, StatRow>,
  supportRows: Record<string, StatRow>,
  surrenderRows: Record<string, StatRow>,
  supportBarBg: Graphics,
  supportBarFill: Graphics,
  surrenderBarBg: Graphics,
  surrenderBarFill: Graphics,
  warSupport: number,
  surrenderRatio: number,
): number {
  let y = PANEL_PADDING;
  titleText.position.set(PANEL_PADDING, y);
  y += titleText.height + 4;

  nameText.position.set(PANEL_PADDING, y);
  y += nameText.height + SECTION_GAP;

  overviewLabel.position.set(PANEL_PADDING, y);
  y += overviewLabel.height + ROW_GAP;
  y = layoutRows(overviewRows, y);

  resourcesLabel.position.set(PANEL_PADDING, y);
  y += resourcesLabel.height + ROW_GAP;
  y = layoutRows(resourcesRows, y);

  supportLabel.position.set(PANEL_PADDING, y + SECTION_GAP);
  y += supportLabel.height + SECTION_GAP + ROW_GAP;
  y = layoutRows(supportRows, y);
  y += ROW_GAP;
  const barWidth = PANEL_WIDTH - PANEL_PADDING * 2;
  drawBar(supportBarBg, supportBarFill, PANEL_PADDING, y, barWidth, warSupport, 0x2b3b55, 0x7aa2ff);
  y += BAR_HEIGHT + SECTION_GAP;

  surrenderLabel.position.set(PANEL_PADDING, y);
  y += surrenderLabel.height + ROW_GAP;
  y = layoutRows(surrenderRows, y);
  y += ROW_GAP;
  drawBar(
    surrenderBarBg,
    surrenderBarFill,
    PANEL_PADDING,
    y,
    barWidth,
    surrenderRatio,
    0x3a2630,
    0xf26d7d,
  );
  y += BAR_HEIGHT + PANEL_PADDING;

  background.clear();
  background.beginFill(PANEL_BG, 0.94);
  background.lineStyle(1, PANEL_BORDER, 0.9);
  background.drawRoundedRect(0, 0, PANEL_WIDTH, y, 10);
  background.endFill();

  panelContent.hitArea = null;
  return y;
}

function layoutRows(rows: Record<string, StatRow>, startY: number): number {
  let y = startY;
  for (const row of Object.values(rows)) {
    row.label.position.set(PANEL_PADDING, y);
    row.value.position.set(PANEL_WIDTH - PANEL_PADDING - row.value.width, y);
    y += Math.max(row.label.height, row.value.height) + ROW_GAP;
  }
  return y + SECTION_GAP;
}

function drawBar(
  bg: Graphics,
  fill: Graphics,
  x: number,
  y: number,
  width: number,
  ratio: number,
  bgColor: number,
  fillColor: number,
): void {
  const clamped = clamp(ratio, 0, 1);
  bg.clear();
  bg.beginFill(bgColor, 0.6);
  bg.drawRoundedRect(x, y, width, BAR_HEIGHT, BAR_RADIUS);
  bg.endFill();

  fill.clear();
  fill.beginFill(fillColor, 0.9);
  fill.drawRoundedRect(x, y, width * clamped, BAR_HEIGHT, BAR_RADIUS);
  fill.endFill();
}

function positionPanel(panelContent: Container, sidebarX: number): void {
  panelContent.position.set(sidebarX + PANEL_MARGIN, PANEL_MARGIN);
}

function layoutTab(
  tabBg: Graphics,
  tabText: Text,
  tabContainer: Container,
  sidebarX: number,
  sidebarWidth: number,
  screenHeight: number,
  isExpanded: boolean,
): void {
  tabText.text = isExpanded ? "CLOSE" : "NATION";
  tabBg.clear();
  tabBg.beginFill(TAB_BG, 0.96);
  tabBg.lineStyle(1, TAB_BORDER, 0.9);
  tabBg.drawRoundedRect(0, 0, TAB_WIDTH, TAB_HEIGHT, 8);
  tabBg.endFill();
  tabText.position.set(TAB_WIDTH / 2, TAB_HEIGHT / 2);

  const tabY = clamp(PANEL_MARGIN, PANEL_MARGIN, screenHeight - TAB_HEIGHT - PANEL_MARGIN);
  const tabX = sidebarX + Math.max(PANEL_MARGIN, sidebarWidth - TAB_WIDTH - PANEL_MARGIN);
  tabContainer.position.set(tabX, tabY);
}

function computeSidebarWidth(screenWidth: number, isExpanded: boolean): number {
  const desired = isExpanded ? SIDEBAR_EXPANDED_WIDTH : SIDEBAR_COLLAPSED_WIDTH;
  const minWidth = Math.min(SIDEBAR_COLLAPSED_WIDTH, screenWidth);
  return clamp(desired, minWidth, screenWidth);
}

function drawSidebarBg(
  bg: Graphics,
  x: number,
  width: number,
  height: number,
): void {
  bg.clear();
  if (width <= 0 || height <= 0) {
    return;
  }
  bg.beginFill(SIDEBAR_BG, 0.95);
  bg.lineStyle(1, SIDEBAR_BORDER, 0.9);
  bg.drawRect(x, 0, width, height);
  bg.endFill();
}

function drawWorldMask(mask: Graphics, width: number, height: number): void {
  mask.clear();
  if (width <= 0 || height <= 0) {
    return;
  }
  mask.beginFill(0xffffff, 1);
  mask.drawRect(0, 0, width, height);
  mask.endFill();
}

function buildNationStats(
  world: WorldState,
  nation: NationRuntime,
  mesoById: Map<MesoRegionId, MesoRegion>,
): {
  displayName: string;
  unitCount: number;
  mesoCount: number;
  cityCount: number;
  warCount: number;
  warSupport: number;
  supportDuration: number;
  supportCapital: number;
  supportCityLoss: number;
  supportRoleMult: number;
  supportBoost: number;
  surrenderScore: number;
  surrenderThreshold: number;
  surrenderOccupation: number;
  surrenderCapital: number;
  surrenderCityLoss: number;
  surrenderUnitLoss: number;
  surrenderMultiplier: number;
  surrenderRatio: number;
  resources: {
    steel: number;
    fuel: number;
    manpower: number;
    weapons: number;
  };
} {
  const unitCount = countUnitsByNation(world.units, nation.id);
  const territoryStats = collectTerritoryStats(
    world.macroRegions,
    mesoById,
    world.occupation.mesoById,
    nation.id,
  );
  const warStats = collectWarStats(world, nation.id);

  const cooperationBalance = WORLD_BALANCE.war.cooperation;
  const surrenderBalance = WORLD_BALANCE.war.surrender;
  const durationRatio = clamp(
    warStats.maxDuration / Math.max(1, cooperationBalance.durationTicksForMaxPenalty),
    0,
    1,
  );
  const capitalFallRatio = clamp(
    nation.capitalFallCount / Math.max(1, cooperationBalance.capitalFallMax),
    0,
    1,
  );
  const cityLossRatio = clamp(
    1 - territoryStats.cityCount / Math.max(1, nation.initialCityCount),
    0,
    1,
  );
  const roleMultiplier = computeRoleMultiplier(
    warStats.aggressorCount,
    warStats.defenderCount,
    cooperationBalance,
  );

  const cooperationRange = Math.max(
    0.0001,
    cooperationBalance.max - cooperationBalance.min,
  );
  const normalizedCooperation = clamp(
    (nation.warCooperation - cooperationBalance.min) / cooperationRange,
    0,
    1,
  );
  const cooperationMultiplier =
    cooperationBalance.surrenderMultiplierAtMin +
    (cooperationBalance.surrenderMultiplierAtMax -
      cooperationBalance.surrenderMultiplierAtMin) *
      normalizedCooperation;

  const occupationRatio = safeRatio(territoryStats.occupiedCount, territoryStats.mesoCount);
  const unitLossRatio = clamp(
    1 - unitCount / Math.max(1, nation.initialUnitCount),
    0,
    1,
  );
  const actualSurrenderScore = nation.surrenderScore;

  const displayName = formatNationName(nation.id);

  return {
    displayName,
    unitCount,
    mesoCount: territoryStats.mesoCount,
    cityCount: territoryStats.cityCount,
    warCount: warStats.warCount,
    warSupport: nation.warCooperation,
    resources: {
      steel: Math.max(0, Math.floor(nation.resources.steel)),
      fuel: Math.max(0, Math.floor(nation.resources.fuel)),
      manpower: Math.max(0, Math.floor(nation.resources.manpower)),
      weapons: Math.max(0, Math.floor(nation.resources.weapons)),
    },
    supportDuration: durationRatio * cooperationBalance.durationWeight,
    supportCapital: capitalFallRatio * cooperationBalance.capitalFallWeight,
    supportCityLoss: cityLossRatio * cooperationBalance.cityLossWeight,
    supportRoleMult: roleMultiplier,
    supportBoost: nation.warCooperationBoost,
    surrenderScore: actualSurrenderScore,
    surrenderThreshold: surrenderBalance.threshold,
    surrenderOccupation: occupationRatio * surrenderBalance.occupationWeight,
    surrenderCapital: capitalFallRatio * surrenderBalance.capitalFallWeight,
    surrenderCityLoss: cityLossRatio * surrenderBalance.cityLossWeight,
    surrenderUnitLoss: unitLossRatio * surrenderBalance.unitLossWeight,
    surrenderMultiplier: cooperationMultiplier,
    surrenderRatio: clamp(
      actualSurrenderScore / Math.max(1, surrenderBalance.threshold),
      0,
      1,
    ),
  };
}

function countUnitsByNation(units: UnitState[], nationId: NationId): number {
  let count = 0;
  for (const unit of units) {
    if (unit.nationId === nationId) {
      count += 1;
    }
  }
  return count;
}

function collectTerritoryStats(
  macroRegions: MacroRegion[],
  mesoById: Map<MesoRegionId, MesoRegion>,
  occupationByMesoId: Map<MesoRegionId, NationId>,
  nationId: NationId,
): {
  mesoCount: number;
  occupiedCount: number;
  cityCount: number;
} {
  let mesoCount = 0;
  let occupiedCount = 0;
  let cityCount = 0;

  for (const macro of macroRegions) {
    if (macro.nationId !== nationId) {
      continue;
    }
    for (const mesoId of macro.mesoRegionIds) {
      const meso = mesoById.get(mesoId);
      if (!meso || meso.type === "sea") {
        continue;
      }
      mesoCount += 1;
      const occupier = occupationByMesoId.get(mesoId);
      if (occupier && occupier !== nationId) {
        occupiedCount += 1;
        continue;
      }
      if (meso.building === "city" || meso.building === "capital") {
        cityCount += 1;
      }
    }
  }

  return { mesoCount, occupiedCount, cityCount };
}

function collectWarStats(
  world: WorldState,
  nationId: NationId,
): {
  warCount: number;
  maxDuration: number;
  aggressorCount: number;
  defenderCount: number;
} {
  let warCount = 0;
  let maxDuration = 0;
  let aggressorCount = 0;
  let defenderCount = 0;

  for (const war of world.wars) {
    if (war.nationAId !== nationId && war.nationBId !== nationId) {
      continue;
    }
    warCount += 1;
    const duration = Math.max(0, world.time.fastTick - war.startedAtFastTick);
    if (duration > maxDuration) {
      maxDuration = duration;
    }
    if (war.aggressorId === nationId) {
      aggressorCount += 1;
    }
    if (war.defenderId === nationId) {
      defenderCount += 1;
    }
  }

  return { warCount, maxDuration, aggressorCount, defenderCount };
}

function computeRoleMultiplier(
  aggressorCount: number,
  defenderCount: number,
  cooperationBalance: typeof WORLD_BALANCE.war.cooperation,
): number {
  const total = aggressorCount + defenderCount;
  if (total <= 0) {
    return 1;
  }
  const aggressorRatio = aggressorCount / total;
  const defenderRatio = defenderCount / total;
  return (
    aggressorRatio * cooperationBalance.aggressorPenaltyMultiplier +
    defenderRatio * cooperationBalance.defenderPenaltyMultiplier
  );
}

function formatNationName(nationId: NationId): string {
  const prefix = "nation-";
  if (nationId.startsWith(prefix)) {
    return `Nation ${nationId.slice(prefix.length)}`;
  }
  return nationId;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return "0.00";
  }
  return value.toFixed(2);
}

function formatInteger(value: number): string {
  if (!Number.isFinite(value)) {
    return "0";
  }
  return Math.max(0, Math.floor(value)).toString();
}

function formatPercent(value: number): string {
  const clamped = clamp(value, 0, 1);
  return `${Math.round(clamped * 100)}%`;
}

function safeRatio(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return 0;
  }
  return numerator / denominator;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
