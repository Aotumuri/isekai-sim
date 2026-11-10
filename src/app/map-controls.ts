import { TERRAIN_LABELS } from "../render/terrain-color";
import { getPlayerNation } from "../sim/player-nation";
import type { MesoRegionId } from "../worldgen/meso-region";
import { TERRAIN_COLORS } from "../render/terrain-color";
import { AGRICULTURE_COLORS } from "../render/agriculture-overlay";
import { isPopulationMode, POPULATION_LABELS } from "../render/population-map";
import { POPULATION_DIMENSIONS, POPULATION_GROUPS, populationColor } from "../sim/regional-population";
import type { NationId } from "../worldgen/nation";
import { getNationFaction } from "../sim/factions";
import { getNationIdeology, getNationName } from "../sim/nation-identity";
import { isNationPresent } from "../sim/nation-active";
import { getSubjectOverlord } from "../sim/subject-governments";
import { getOwnerByMesoId } from "../sim/world-cache";
import type { WorldState } from "../sim/world-state";
import { getMapView, selectMapNation, setMapMode, type MapMode } from "../render/map-view-state";
import { CLAIM_COLORS, getMapClaims } from "../render/claim-map-data";
import { DIPLOMATIC_COLORS, getDiplomaticStatus, getFactionColor, getOccupationSummary, getPoliticalFill, SUBJECT_MAP_MARKER } from "../render/political-map-data";
import { buildRegionBounds, findRegion } from "../render/region/hit-test";
import type { Renderer } from "../render/renderer";
import type { FrontDebugOverlay } from "../render/front-debug-overlay";
const esc = (value: unknown) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));
const POPULATION_KEYS = ["Q", "W", "R"] as const;
const color = (value: number) => `#${value.toString(16).padStart(6, "0")}`;

export function attachMapControls(root: HTMLElement, renderer: Renderer, world: WorldState,
  debug: FrontDebugOverlay, society: { openDiplomacy: () => void; openFactions: () => void; close: () => void }, onRegionSelected?: (id: MesoRegionId | null) => void): { update: () => void } {
  const controls = document.createElement("section"); controls.className = "map-controls"; controls.setAttribute("aria-label", "地図表示");
  controls.innerHTML = `<nav class="map-mode-buttons" aria-label="地図モード"><button type="button" data-map-mode="political">国境</button><button type="button" data-map-mode="terrain">地形</button><button type="button" data-map-mode="diplomacy">外交 <kbd>E</kbd></button><button type="button" data-map-mode="factions">陣営</button><button type="button" data-map-mode="claims">領土請求 <kbd>C</kbd></button>${POPULATION_DIMENSIONS.map((mode, index) => `<button type="button" data-map-mode="${mode}">${POPULATION_LABELS[mode]} <kbd>${POPULATION_KEYS[index]}</kbd></button>`).join("")}<button type="button" data-map-mode="debug">デバッグ <kbd>F</kbd></button></nav>
    <details class="map-display-options"><summary>表示設定</summary><label><input type="checkbox" data-map-option="provinceBorders" checked> 州境</label><label><input type="checkbox" data-map-option="districtBorders"> 地区境界</label><label><input type="checkbox" data-map-option="labels" checked> 国名</label><label><input type="checkbox" data-map-option="occupations" checked> 占領地の表示</label><label><input type="checkbox" data-map-option="farmland"> 農地</label></details>
    <div class="map-selection" data-map-view="selection"></div><div class="map-legend" data-map-view="legend"></div><p class="map-message" role="status" data-map-view="message"></p>`;
  root.appendChild(controls);
  const view = (name: string) => controls.querySelector<HTMLElement>(`[data-map-view="${name}"]`)!;
  const enter = (mode: MapMode) => {
    if (!setMapMode(world, mode)) { view("message").textContent = "先に地図で国を選んでください。"; return; }
    view("message").textContent = "";
    if (mode === "diplomacy") society.openDiplomacy();
    else society.close();
    update(true);
  };
  controls.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button"); if (!button) return;
    if (button.dataset.mapMode) enter(button.dataset.mapMode as MapMode);
    if (button.dataset.mapAction === "diplomacy") enter("diplomacy");
    if (button.dataset.mapAction === "factions") society.openFactions();
  });
  controls.addEventListener("change", (event) => {
    const input = event.target as HTMLInputElement, key = input.dataset.mapOption as "provinceBorders" | "districtBorders" | "labels" | "occupations" | "farmland";
    if (key) { const state = getMapView(world); state[key] = input.checked; state.revision += 1; update(true); }
  });
  const bounds = buildRegionBounds(world.microRegions);
  let down: { x: number; y: number } | null = null, dragged = false;
  renderer.app.stage.on("pointerdown", (event) => { down = { x: event.global.x, y: event.global.y }; dragged = false; });
  renderer.app.stage.on("pointermove", (event) => { if (down && Math.hypot(event.global.x - down.x, event.global.y - down.y) > 5) dragged = true; });
  renderer.app.stage.on("pointertap", (event) => {
    down = null;
    if (dragged || event.button !== 0 || event.global.x > renderer.app.screen.width - renderer.uiRightWidth) { dragged = false; return; }
    const point = renderer.worldContainer.toLocal(event.global), region = findRegion(point, world.microRegions, bounds);
    const owner = region?.mesoRegionId ? getOwnerByMesoId(world).get(region.mesoRegionId) ?? null : null;
    onRegionSelected?.(region?.mesoRegionId ?? null);
    selectMapNation(world, owner);
    if (getMapView(world).mode === "diplomacy" && owner && !getPlayerNation(world)) society.openDiplomacy();
    update(true);
  });
  window.addEventListener("keydown", (event) => {
    if (event.repeat || (event.target instanceof HTMLElement && (event.target.isContentEditable || event.target.closest("input,select,textarea")))) return;
    if (!event.ctrlKey && !event.metaKey && !event.altKey) {
      const mode = POPULATION_DIMENSIONS.find((_, index) => event.code === `Key${POPULATION_KEYS[index]}`);
      if (mode) { event.preventDefault(); enter(getMapView(world).mode === mode ? "political" : mode); }
      if (event.code === "Escape" && isPopulationMode(getMapView(world).mode)) enter("political");
    }
    if (event.code === "KeyE") { event.preventDefault(); enter("diplomacy"); }
    if (event.code === "KeyF") { event.preventDefault(); enter(getMapView(world).mode === "debug" ? "political" : "debug"); }
    if (event.code === "KeyC" && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); const state = getMapView(world); enter(state.mode === "claims" ? state.claimsReturnMode ?? "political" : "claims"); }
    if (event.code === "KeyD") enter("debug");
    if (event.code === "Escape" && ["diplomacy", "claims"].includes(getMapView(world).mode)) { const state = getMapView(world); enter(state.mode === "claims" ? state.claimsReturnMode ?? "political" : "political"); }
  });
  let lastRender = -Infinity, lastContentKey = "";
  const update = (force = false) => {
    const state = getMapView(world);
    const active = world.nations.filter((nation) => isNationPresent(world, nation));
    if (state.selectedNationId && !active.some((nation) => nation.id === state.selectedNationId)) {
      state.selectedNationId = null; state.diplomaticFocusId = null; state.targetNationId = null;
      if (state.mode === "diplomacy" || state.mode === "claims") state.mode = "political";
      state.revision += 1;
    }
    if (state.diplomaticFocusId && !active.some((nation) => nation.id === state.diplomaticFocusId)) {
      state.diplomaticFocusId = null;
      if (state.mode === "diplomacy" || state.mode === "claims") state.mode = "political";
      state.revision += 1;
    }
    debug.setEnabled(state.mode === "debug");
    const panel = renderer.uiContainer.getChildByName("FrontDebugConfig"); if (panel) panel.visible = state.mode === "debug";
    if (!force && performance.now() - lastRender < 500) return;
    lastRender = performance.now();
    const claims = state.mode === "claims" && state.selectedNationId ? getMapClaims(world, state.selectedNationId) : [];
    const contentKey = JSON.stringify([world.populationPolicyRevision ?? 0, world.exileGovernments?.version ?? 0, claims, state.mode, state.revision, world.factions?.version ?? 0,
      active.map((nation) => [nation.id, nation.name, nation.ideologyId]), world.occupation.version, world.territoryVersion, world.militaryAccess?.version ?? 0,
      state.diplomaticFocusId && state.targetNationId ? getDiplomaticStatus(world, state.diplomaticFocusId, state.targetNationId) : null]);
    if (contentKey === lastContentKey) return;
    lastContentKey = contentKey;
    for (const button of controls.querySelectorAll<HTMLElement>("[data-map-mode]")) button.setAttribute("aria-pressed", String(button.dataset.mapMode === state.mode));
    const selected = state.selectedNationId;
    view("selection").innerHTML = selected ? `<strong>${esc(getNationName(world, selected))}</strong><span>${world.exileGovernments?.byNationId.get(selected)?.status === "exiled" ? `Government in exile · 受入国：${esc(getNationName(world, world.exileGovernments.byNationId.get(selected)!.hostId))} · ` : ""}${esc(getNationIdeology(world, selected).name)} · ${esc(getNationFaction(world, selected)?.name ?? "無所属")}</span><button type="button" data-map-action="diplomacy">外交を開く · E</button><button type="button" data-map-mode="claims">領土請求を見る · C</button>` : '<span>地図で国を選択してください。E：外交 · C：領土請求</span>';
    if (state.mode === "diplomacy" && state.diplomaticFocusId) {
      const labels = { selected: "基準国", friendly: "友好", neutral: "中立", hostile: "敵対", war: "交戦中" };
      view("legend").innerHTML = `<h2>外交関係： ${esc(getNationName(world, state.diplomaticFocusId))}</h2>${Object.entries(DIPLOMATIC_COLORS).map(([status, value]) => `<span class="map-legend-item"><i style="background:${color(value)}"></i>${labels[status as keyof typeof labels]}</span>`).join("")}${state.targetNationId ? `<p>${esc(getNationName(world, state.targetNationId))}: ${labels[getDiplomaticStatus(world, state.diplomaticFocusId, state.targetNationId)]}</p>` : ""}`;
    } else if (state.mode === "claims" && selected) {
      const owners = new Map<NationId, number>();
      for (const claim of claims) owners.set(claim.ownerId, (owners.get(claim.ownerId) ?? 0) + 1);
      view("legend").innerHTML = `<h2>領土請求 · ${esc(getNationName(world, selected))}</h2>
        <span class="map-legend-item"><i style="background:${color(CLAIM_COLORS.home)}"></i>自国領</span>
        <span class="map-legend-item"><i style="background:${color(CLAIM_COLORS.weak)}"></i>関心 · 20</span>
        <span class="map-legend-item"><i style="background:${color(CLAIM_COLORS.strong)}"></i>強い請求 · 100</span>
        <span class="map-legend-item"><i style="background:transparent;border:2px solid ${color(CLAIM_COLORS.demand)}"></i>発出中の最後通牒</span>
        <p>${claims.length ? `${claims.length}地区に請求あり · ${claims.filter((claim) => claim.demanded).length}件を正式に要求中` : "外国領への請求はありません。"}</p>
        ${[...owners].map(([id, count]) => `<span class="map-legend-item">${esc(getNationName(world, id))} · ${count} ${count === 1 ? "district" : "districts"}</span>`).join("")}
        <p>地区の詳細は Space 長押し。他国の請求は地図から選択。C / Esc：戻る</p>`;
    } else if (isPopulationMode(state.mode)) {
      view("legend").innerHTML = `<h2>${POPULATION_LABELS[state.mode]} by district</h2>${POPULATION_GROUPS[state.mode].map((name, index) => `<span class="map-legend-item"><i style="background:${color(populationColor(index))}"></i>${name}</span>`).join("")}<p>地色は最大の集団を示し、2番目の集団が20%以上なら色付きの点で表示します。構成比は Space 長押しで確認できます。</p>`;
    } else if (state.mode === "factions") {
      const factions = (world.factions?.factions ?? []).filter((faction) => faction.memberIds.some((id) => active.some((nation) => nation.id === id)));
      const nonAligned = active.filter((nation) => !getNationFaction(world, nation.id)).length;
      view("legend").innerHTML = `<h2>陣営の色</h2>${factions.map((faction) => `<span class="map-legend-item"><i style="background:${color(getFactionColor(faction.id))}"></i>${esc(faction.name)} · 指導国：${esc(getNationName(world, faction.leaderId))} · ${faction.memberIds.filter((id) => active.some((nation) => nation.id === id)).length}</span>`).join("")}<span class="map-legend-item"><i style="background:#7b8899"></i>無所属 · ${nonAligned}</span><button type="button" data-map-action="factions">陣営を管理</button>`;
    } else if (state.mode === "terrain") {
      view("legend").innerHTML = Object.entries(TERRAIN_COLORS).map(([label, value]) =>
        `<span class="map-legend-item"><i style="background:${color(value)}"></i>${TERRAIN_LABELS[label as keyof typeof TERRAIN_LABELS]}</span>`).join("");
    } else view("legend").innerHTML = state.mode === "debug" ? '<span>デバッグ表示では地区境界、占領地、作戦の目印を表示します。</span>' : "";
    if (state.mode !== "debug" && state.labels && active.some(({ id }) => getSubjectOverlord(world, id))) {
      view("legend").innerHTML += `<span class="map-legend-item">${SUBJECT_MAP_MARKER} 傀儡政権</span>`;
    }
    if (state.mode !== "debug" && state.mode !== "terrain" && state.farmland) {
      view("legend").innerHTML += `<h2>農地</h2>${AGRICULTURE_COLORS.map(({ color: tint, label }) =>
        `<span class="map-legend-item"><i style="background:${color(tint)}"></i>${label}</span>`).join("")}`;
    }
    if (state.mode !== "debug" && state.mode !== "terrain" && state.occupations) {
      const occupations = getOccupationSummary(world);
      if (occupations.length) view("legend").innerHTML += `<h2>占領地</h2><span class="map-legend-item"><i class="occupation-swatch"></i>斜線は占領国、境界線は領有国を示します。</span>${occupations.slice(0, 5).map((entry) => `<span class="map-legend-item"><i style="background:${color(getPoliticalFill(world, entry.occupierId))}"></i>${esc(getNationName(world, entry.ownerId))} → ${esc(getNationName(world, entry.occupierId))} · ${entry.regions}</span>`).join("")}`;
    }
  };
  update(true);
  return { update: () => update() };
}
