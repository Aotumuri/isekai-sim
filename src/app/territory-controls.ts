import { getPeaceBorderIssue } from "../sim/peace-borders";
import type { NationId } from "../worldgen/nation";
import type { MesoRegionId } from "../worldgen/meso-region";
import type { WorldState } from "../sim/world-state";
import { getForeignClaims, getTerritorialClaim } from "../sim/territorial-claims";
import { getNationName } from "../sim/nation-identity";
import { openDiplomaticCrisis, respondToCrisis, betrayTerritorialSettlement } from "../sim/diplomatic-crises";
import { getRelation } from "../sim/diplomacy";
import { getTerritorialDeals, proposeTerritorialExchange, respondToTerritorialOffer, withdrawTerritorialOffer, territorialValue } from "../sim/territorial-deals";
import { constructPort, getPortConstructionIssue, PORT_CONSTRUCTION_COST } from "../sim/port-construction";
import { splitProvince } from "../sim/territory-transfer";
import { getWarDeclarationMode } from "../sim/simulation-settings";
import { getMapView } from "../render/map-view-state";

const esc = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
export function districtName(id: MesoRegionId): string { return `District ${id.replace("meso-", "")}`; }
export function attachTerritoryControls(root: HTMLElement, world: WorldState, selected: () => NationId, partner: () => NationId,
  feedback: (message: string) => void): { update: () => void; clearPreview: () => void } {
  root.innerHTML = `<h2>Territorial claims</h2><p class="society-note">Long ownership strengthens attachment. Resources make neighboring districts desirable. Claims persist after loss; they do not grant ownership.</p><div data-territory-view="claims"></div>
    <h2>Territorial settlement</h2><p class="society-note">Choose individual districts or entire provinces below. Gold highlights show the selected parcels on the map. A cession automatically divides a province when necessary. Each nation must retain at least one district.</p>
    <div class="territory-parcels"><section><h3>Your offer / administrative split</h3><div data-territory-view="offered"></div></section><section><h3>Requested from partner</h3><div data-territory-view="requested"></div></section></div>
    <p class="society-note" data-territory-view="valuation"></p>
    <div class="society-actions"><button type="button" data-territory-action="exchange">Propose territory exchange · 8</button><button type="button" data-territory-action="ultimatum" class="society-danger">Demand selected territory · 12</button><button type="button" data-territory-action="split">Split selected province</button><button type="button" data-territory-action="clear">Clear parcels</button></div>
    <p class="society-note">Ultimatums demand only the requested districts (1–8) with a claim of at least 20. Your offered parcels are not part of an ultimatum. The recipient can accept, negotiate or reject. Rejection may lead to war. A split requires a connected subset of one of your provinces.</p>
    <h2>Port construction</h2><p class="society-note" data-territory-view="port"></p>
    <button type="button" data-territory-action="build-port">Build port · ${PORT_CONSTRUCTION_COST.steel} steel / ${PORT_CONSTRUCTION_COST.fuel} fuel</button>
    <div data-territory-view="crisis"></div><h2>Territorial offers</h2><p class="society-note">The recipient may respond here. AI reviews pending offers after 10 game seconds; proposals expire after 60. Values reflect resources, facilities, attachment and the capital.</p><div data-territory-view="offers"></div>`;
  const view = (name: string) => root.querySelector<HTMLElement>(`[data-territory-view="${name}"]`)!;
  const picked = (side: string): MesoRegionId[] => [...root.querySelectorAll<HTMLInputElement>(`input[data-parcel-side="${side}"]:checked`)].map((input) => input.value as MesoRegionId);
  const clearPreview = () => {
    for (const input of root.querySelectorAll<HTMLInputElement>("input[type=checkbox]")) input.checked = false;
    const map = getMapView(world);
    if (map.territoryPreviewIds?.length) { map.territoryPreviewIds = []; map.revision++; }
  };
  const preview = () => { const map = getMapView(world); map.territoryPreviewIds = [...picked("offered"), ...picked("requested")]; map.revision++; };
  let listKey = "", detailKey = "";
  const update = () => {
    const a = selected(), b = partner(); if (!a || !b) return;
    const nextKey = `${a}:${b}:${world.territoryVersion}:${world.buildingVersion}`;
    if (nextKey !== listKey) {
      listKey = nextKey; clearPreview();
      for (const [side, owner] of [["offered", a], ["requested", b]] as const) {
        view(side).innerHTML = world.macroRegions.filter((macro) => macro.nationId === owner).map((macro, index) => `<details class="territory-province"><summary>Province ${index + 1} · ${macro.mesoRegionIds.length} ${macro.mesoRegionIds.length === 1 ? "district" : "districts"}</summary><label><input type="checkbox" data-province-side="${side}" data-province-id="${esc(macro.id)}"> Select entire province ${index + 1}</label>${macro.mesoRegionIds.map((id) => {
          const region = world.mesoRegions.find((item) => item.id === id);
          const features = [region?.resource === "fuel" ? "Fuel" : region?.resource === "steel" ? "Steel" : "", region?.building ?? ""].filter(Boolean).join(" · ");
          return `<label><input type="checkbox" data-parcel-side="${side}" data-province="${esc(macro.id)}" value="${esc(id)}"> ${districtName(id)}${features ? ` · ${features}` : ""}</label>`;
        }).join("")}</details>`).join("");
      }
    }
    const offers = getTerritorialDeals(world).offers.filter((offer) => offer.proposerId === a || offer.targetId === a).slice(-8).reverse();
    const claims = getForeignClaims(world, a, b), relation = getRelation(world, a, b), crisis = relation.crisis;
    const detail = JSON.stringify([a, b, world.time.slowTick, world.territoryVersion, picked("offered"), picked("requested"), offers.map((offer) => [offer.id, offer.status]), crisis]);
    if (detail === detailKey) return; detailKey = detail;
    view("claims").innerHTML = `<p class="society-note">Claims against ${esc(getNationName(world, b))}: ${claims.length}</p>${claims.slice(0, 10).map((claim) => `<p class="society-note"><button type="button" data-territory-action="select-claim" data-region-id="${esc(claim.regionId)}">Select ${districtName(claim.regionId)}</button> · Claim ${Math.round(claim.strength)}/100 · Previously owned for ${claim.heldTicks}s</p>`).join("") || '<p class="society-note">No significant claims against this partner.</p>'}`;
    const offered = picked("offered"), requested = picked("requested");
    view("valuation").textContent = `Selected: ${offered.length} offered / ${requested.length} requested. Partner values: receives ${territorialValue(world, b, offered).toFixed(0)} / cedes ${territorialValue(world, b, requested).toFixed(0)}. Your claims on requested districts: ${requested.map((id) => `${districtName(id)} ${Math.round(getTerritorialClaim(world, a, id))}`).join(", ") || "none"}.`;
    const portIssue = offered.length === 1
      ? getPortConstructionIssue(world, a, offered[0])
      : "Select one of your districts in the left column.";
    view("port").textContent = portIssue ?? `A new port in ${districtName(offered[0])} will support shipbuilding and naval routes.`;
    view("crisis").innerHTML = crisis?.demand === "territory" ? `<h3>Territorial ultimatum</h3><p>${esc(getNationName(world, crisis.aggressorId))} demands ${(crisis.regionIds ?? []).map(districtName).join(", ")} · ${Math.max(0, crisis.deadlineSlowTick - world.time.slowTick)}s remaining.</p>${crisis.aggressorId !== a ? '<div class="society-actions"><button type="button" data-territory-action="concede">Accept territorial demand</button><button type="button" data-territory-action="negotiate">Negotiate · 15</button><button type="button" data-territory-action="reject">Reject demand</button></div>' : ""}` : relation.territorialSettlement && world.time.slowTick - relation.territorialSettlement.atSlowTick < 120 && relation.treaties.some((treaty) => treaty.type === "truce" && treaty.expiresAtSlowTick === relation.territorialSettlement!.atSlowTick + 120 && treaty.expiresAtSlowTick > world.time.slowTick) ? '<p class="society-note">A territorial settlement is protected by a truce. Betrayal damages international trust.</p><button type="button" class="society-danger" data-territory-action="betray">Break settlement and declare war · 20</button>' : "";
    view("offers").innerHTML = offers.map((offer) => `<article class="faction-entry"><strong>${esc(getNationName(world, offer.proposerId))} → ${esc(getNationName(world, offer.targetId))} · ${offer.status}</strong><p class="society-note">Offers: ${offer.offered.map(districtName).join(", ") || "nothing"}<br>Requests: ${offer.requested.map(districtName).join(", ") || "nothing"}</p>${offer.status === "pending" ? `<div class="society-actions">${offer.targetId === a ? `<button type="button" data-territory-action="accept" data-offer-id="${offer.id}">Accept exchange</button><button type="button" data-territory-action="decline" data-offer-id="${offer.id}">Decline exchange</button>` : `<button type="button" data-territory-action="withdraw" data-offer-id="${offer.id}">Withdraw proposal</button>`}</div>` : ""}</article>`).join("") || '<p class="society-note">No territorial offers yet.</p>';
    for (const button of root.querySelectorAll<HTMLButtonElement>("button[data-territory-action]")) button.disabled =
      button.dataset.territoryAction === "build-port" ? portIssue !== null :
        !["clear", "split", "select-claim"].includes(button.dataset.territoryAction!) && (getWarDeclarationMode(world) !== "diplomacy" || a === b);
  };
  root.addEventListener("change", (event) => {
    const input = event.target as HTMLInputElement;
    if (input.dataset.provinceSide) for (const parcel of root.querySelectorAll<HTMLInputElement>("input[data-parcel-side]")) {
      if (parcel.dataset.parcelSide === input.dataset.provinceSide && parcel.dataset.province === input.dataset.provinceId) parcel.checked = input.checked;
    }
    preview(); update();
  });
  root.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-territory-action]"); if (!button) return;
    event.stopPropagation(); const a = selected(), b = partner(), action = button.dataset.territoryAction;
    let success = false;
    if (action === "select-claim") {
      const input = [...root.querySelectorAll<HTMLInputElement>('input[data-parcel-side="requested"]')].find((item) => item.value === button.dataset.regionId);
      if (input) { input.checked = true; const group = input.closest("details"); if (group) group.open = true; preview(); update(); }
      return;
    }
    if (action === "clear") {
      for (const input of root.querySelectorAll<HTMLInputElement>("input[type=checkbox]")) input.checked = false;
      preview(); update(); return;
    }
    if (action === "build-port") {
      const ids = picked("offered");
      success = ids.length === 1 && constructPort(world, a, ids[0]);
      feedback(success ? `Port built in ${districtName(ids[0])}.` : "Select one safe, supplied coastal district and check construction resources.");
      update();
      return;
    }
    if (action === "exchange" || action === "ultimatum") {
      const offered = picked("offered"), requested = picked("requested");
      const issue = getPeaceBorderIssue(world, [
        ...(action === "exchange" && offered.length ? [{ from: a, to: b, regionIds: offered }] : []),
        ...(requested.length ? [{ from: b, to: a, regionIds: requested }] : []),
      ]);
      if (issue) { feedback(issue); return; }
    }
    if (action === "exchange") success = !!proposeTerritorialExchange(world, a, b, picked("offered"), picked("requested"));
    if (action === "ultimatum") success = openDiplomaticCrisis(world, a, b, picked("requested"));
    if (action === "split") {
      const ids = picked("offered"), macro = world.macroRegions.find((item) => item.nationId === a && ids.length && ids.every((id) => item.mesoRegionIds.includes(id)));
      success = !!macro && splitProvince(world, a, macro.id, ids);
    }
    if (action === "concede" || action === "negotiate" || action === "reject") success = respondToCrisis(world, a, b, action);
    if (action === "betray") success = betrayTerritorialSettlement(world, a, b);
    if (action === "accept" || action === "decline") success = respondToTerritorialOffer(world, a, Number(button.dataset.offerId), action === "accept");
    if (action === "withdraw") success = withdrawTerritorialOffer(world, a, Number(button.dataset.offerId));
    feedback(success ? "Territorial action completed. Check claims, ownership, offers and history." : "Cannot complete: check claims, ownership, influence, treaties, military reach, capital protection and the selected parcels.");
    update();
  });
  return { update, clearPreview };
}
