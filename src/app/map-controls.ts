import type { NationId } from "../worldgen/nation";
import { getNationFaction } from "../sim/factions";
import { getNationIdeology, getNationName } from "../sim/nation-identity";
import { isNationActive } from "../sim/nation-active";
import { getOwnerByMesoId } from "../sim/world-cache";
import type { WorldState } from "../sim/world-state";
import { getMapView, selectMapNation, setMapMode, type MapMode } from "../render/map-view-state";
import { CLAIM_COLORS, getMapClaims } from "../render/claim-map-data";
import { DIPLOMATIC_COLORS, getDiplomaticStatus, getFactionColor, getOccupationSummary, getPoliticalFill } from "../render/political-map-data";
import { buildRegionBounds, findRegion } from "../render/region/hit-test";
import type { Renderer } from "../render/renderer";
import type { FrontDebugOverlay } from "../render/front-debug-overlay";
const esc = (value: unknown) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));
const color = (value: number) => `#${value.toString(16).padStart(6, "0")}`;

export function attachMapControls(root: HTMLElement, renderer: Renderer, world: WorldState,
  debug: FrontDebugOverlay, society: { openDiplomacy: () => void; openFactions: () => void; close: () => void }): { update: () => void } {
  const controls = document.createElement("section"); controls.className = "map-controls"; controls.setAttribute("aria-label", "Map display");
  controls.innerHTML = `<nav class="map-mode-buttons" aria-label="Map modes"><button type="button" data-map-mode="political">Political</button><button type="button" data-map-mode="diplomacy">Diplomacy <kbd>E</kbd></button><button type="button" data-map-mode="factions">Factions</button><button type="button" data-map-mode="claims">Claims <kbd>C</kbd></button><button type="button" data-map-mode="debug">Debug <kbd>F</kbd></button></nav>
    <details class="map-display-options"><summary>Display settings</summary><label><input type="checkbox" data-map-option="provinceBorders" checked> Province borders</label><label><input type="checkbox" data-map-option="districtBorders"> District grid</label><label><input type="checkbox" data-map-option="labels" checked> Country names</label><label><input type="checkbox" data-map-option="occupations" checked> Occupation overlay</label></details>
    <div class="map-selection" data-map-view="selection"></div><div class="map-legend" data-map-view="legend"></div><p class="map-message" role="status" data-map-view="message"></p>`;
  root.appendChild(controls);
  const view = (name: string) => controls.querySelector<HTMLElement>(`[data-map-view="${name}"]`)!;
  const enter = (mode: MapMode) => {
    if (!setMapMode(world, mode)) { view("message").textContent = "Select a nation on the map first."; return; }
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
    const input = event.target as HTMLInputElement, key = input.dataset.mapOption as "provinceBorders" | "districtBorders" | "labels" | "occupations";
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
    selectMapNation(world, owner);
    if (getMapView(world).mode === "diplomacy" && owner) society.openDiplomacy();
    update(true);
  });
  window.addEventListener("keydown", (event) => {
    if (event.repeat || (event.target instanceof HTMLElement && (event.target.isContentEditable || event.target.closest("input,select,textarea")))) return;
    if (event.code === "KeyE") { event.preventDefault(); enter("diplomacy"); }
    if (event.code === "KeyF") { event.preventDefault(); enter(getMapView(world).mode === "debug" ? "political" : "debug"); }
    if (event.code === "KeyC" && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); const state = getMapView(world); enter(state.mode === "claims" ? state.claimsReturnMode ?? "political" : "claims"); }
    if (event.code === "KeyD") enter("debug");
    if (event.code === "Escape" && ["diplomacy", "claims"].includes(getMapView(world).mode)) { const state = getMapView(world); enter(state.mode === "claims" ? state.claimsReturnMode ?? "political" : "political"); }
  });
  let lastRender = -Infinity, lastContentKey = "";
  const update = (force = false) => {
    const state = getMapView(world);
    const active = world.nations.filter(isNationActive);
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
    const contentKey = JSON.stringify([claims, state.mode, state.revision, world.factions?.version ?? 0,
      active.map((nation) => [nation.id, nation.name, nation.ideologyId]), world.occupation.version, world.territoryVersion,
      state.diplomaticFocusId && state.targetNationId ? getDiplomaticStatus(world, state.diplomaticFocusId, state.targetNationId) : null]);
    if (contentKey === lastContentKey) return;
    lastContentKey = contentKey;
    for (const button of controls.querySelectorAll<HTMLElement>("[data-map-mode]")) button.setAttribute("aria-pressed", String(button.dataset.mapMode === state.mode));
    const selected = state.selectedNationId;
    view("selection").innerHTML = selected ? `<strong>${esc(getNationName(world, selected))}</strong><span>${esc(getNationIdeology(world, selected).name)} · ${esc(getNationFaction(world, selected)?.name ?? "Non-aligned")}</span><button type="button" data-map-action="diplomacy">Open diplomacy · E</button><button type="button" data-map-mode="claims">View territorial claims · C</button>` : '<span>Click a nation to select it. E: Diplomacy · C: Territorial claims.</span>';
    if (state.mode === "diplomacy" && state.diplomaticFocusId) {
      const labels = { selected: "Reference nation", friendly: "Friendly", neutral: "Neutral", hostile: "Hostile", war: "At war" };
      view("legend").innerHTML = `<h2>Relations with ${esc(getNationName(world, state.diplomaticFocusId))}</h2>${Object.entries(DIPLOMATIC_COLORS).map(([status, value]) => `<span class="map-legend-item"><i style="background:${color(value)}"></i>${labels[status as keyof typeof labels]}</span>`).join("")}${state.targetNationId ? `<p>${esc(getNationName(world, state.targetNationId))}: ${labels[getDiplomaticStatus(world, state.diplomaticFocusId, state.targetNationId)]}</p>` : ""}`;
    } else if (state.mode === "claims" && selected) {
      const owners = new Map<NationId, number>();
      for (const claim of claims) owners.set(claim.ownerId, (owners.get(claim.ownerId) ?? 0) + 1);
      view("legend").innerHTML = `<h2>Territorial claims · ${esc(getNationName(world, selected))}</h2>
        <span class="map-legend-item"><i style="background:${color(CLAIM_COLORS.home)}"></i>Home territory</span>
        <span class="map-legend-item"><i style="background:${color(CLAIM_COLORS.weak)}"></i>Interest · 20</span>
        <span class="map-legend-item"><i style="background:${color(CLAIM_COLORS.strong)}"></i>Strong claim · 100</span>
        <span class="map-legend-item"><i style="background:transparent;border:2px solid ${color(CLAIM_COLORS.demand)}"></i>Active ultimatum</span>
        <p>${claims.length ? `${claims.length} claimed districts · ${claims.filter((claim) => claim.demanded).length} formally demanded` : "No foreign territorial claims."}</p>
        ${[...owners].map(([id, count]) => `<span class="map-legend-item">${esc(getNationName(world, id))} · ${count} ${count === 1 ? "district" : "districts"}</span>`).join("")}
        <p>Hold Space over a district for details. Click another nation to view its claims. C / Esc: Return.</p>`;
    } else if (state.mode === "factions") {
      const factions = (world.factions?.factions ?? []).filter((faction) => faction.memberIds.some((id) => active.some((nation) => nation.id === id)));
      const nonAligned = active.filter((nation) => !getNationFaction(world, nation.id)).length;
      view("legend").innerHTML = `<h2>Faction colors</h2>${factions.map((faction) => `<span class="map-legend-item"><i style="background:${color(getFactionColor(faction.id))}"></i>${esc(faction.name)} · Leader: ${esc(getNationName(world, faction.leaderId))} · ${faction.memberIds.filter((id) => active.some((nation) => nation.id === id)).length}</span>`).join("")}<span class="map-legend-item"><i style="background:#7b8899"></i>Non-aligned · ${nonAligned}</span><button type="button" data-map-action="factions">Manage factions</button>`;
    } else view("legend").innerHTML = state.mode === "debug" ? '<span>Debug view: original district grid, occupation overlays and operational markers.</span>' : "";
    if (state.mode !== "debug" && state.occupations) {
      const occupations = getOccupationSummary(world);
      if (occupations.length) view("legend").innerHTML += `<h2>Occupied territory</h2><span class="map-legend-item"><i class="occupation-swatch"></i>Stripes show the occupier; borders show the owner.</span>${occupations.slice(0, 5).map((entry) => `<span class="map-legend-item"><i style="background:${color(getPoliticalFill(world, entry.occupierId))}"></i>${esc(getNationName(world, entry.ownerId))} → ${esc(getNationName(world, entry.occupierId))} · ${entry.regions}</span>`).join("")}`;
    }
  };
  update(true);
  return { update: () => update() };
}
