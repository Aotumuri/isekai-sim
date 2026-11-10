import { isStrategicResource, STRATEGIC_RESOURCE_NAMES } from "../data/strategic-resources";
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
export function districtName(id: MesoRegionId): string { return `地区 ${id.replace("meso-", "")}`; }
export function attachTerritoryControls(root: HTMLElement, world: WorldState, selected: () => NationId, partner: () => NationId,
  feedback: (message: string) => void): { update: () => void; clearPreview: () => void } {
  root.innerHTML = `<h2>領土請求</h2><p class="society-note">長く領有すると愛着が強まります。資源のある隣接地区は請求の対象になりやすく、領土を失った後も請求は残ります。</p><div data-territory-view="claims"></div>
    <h2>領土交渉</h2><p class="society-note">地区単位または州全体で選べます。選んだ領土は地図で金色に表示されます。譲渡時には必要に応じて州が分割されます。各国には少なくとも1地区を残す必要があります。</p>
    <div class="territory-parcels"><section><h3>譲渡する地区・分割対象</h3><div data-territory-view="offered"></div></section><section><h3>相手国に要求する地区</h3><div data-territory-view="requested"></div></section></div>
    <p class="society-note" data-territory-view="valuation"></p>
    <div class="society-actions"><button type="button" data-territory-action="exchange">領土交換を提案 · 8</button><button type="button" data-territory-action="ultimatum" class="society-danger">選択した領土を要求 · 12</button><button type="button" data-territory-action="split">選択した州を分割</button><button type="button" data-territory-action="clear">地区の選択を解除</button></div>
    <p class="society-note">最後通牒で要求する各地区には、20以上の請求が必要です。州全体だけを選ぶ場合は、各州の1地区が条件を満たせば要求できます。自国の譲渡地区は最後通牒に含まれません。相手国は受諾、交渉、拒否を選べます。拒否は開戦につながる場合があります。州を分割するには、同じ州の隣接する地区を選んでください。</p>
    <h2>港の建設</h2><p class="society-note" data-territory-view="port"></p>
    <button type="button" data-territory-action="build-port">港を建設 · ${PORT_CONSTRUCTION_COST.steel} steel / ${PORT_CONSTRUCTION_COST.fuel} fuel</button>
    <div data-territory-view="crisis"></div><h2>領土提案</h2><p class="society-note">受け取った提案にはここで回答できます。AIはゲーム内の10秒後に検討し、提案は60秒で失効します。領土の価値には資源、施設、愛着、首都の有無が反映されます。</p><div data-territory-view="offers"></div>`;
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
        view(side).innerHTML = world.macroRegions.filter((macro) => macro.nationId === owner).map((macro, index) => `<details class="territory-province"><summary>州 ${index + 1} · ${macro.mesoRegionIds.length} ${macro.mesoRegionIds.length === 1 ? "district" : "districts"}</summary><label><input type="checkbox" data-province-side="${side}" data-province-id="${esc(macro.id)}"> 第${index + 1}州をすべて選択</label>${macro.mesoRegionIds.map((id) => {
          const region = world.mesoRegions.find((item) => item.id === id);
          const features = [region?.resource === "fuel" ? "燃料" : region?.resource === "steel" ? "鋼材" : isStrategicResource(region?.resource) ? STRATEGIC_RESOURCE_NAMES[region.resource] : "", region?.building ?? ""].filter(Boolean).join(" · ");
          return `<label><input type="checkbox" data-parcel-side="${side}" data-province="${esc(macro.id)}" value="${esc(id)}"> ${districtName(id)}${features ? ` · ${features}` : ""}</label>`;
        }).join("")}</details>`).join("");
      }
    }
    const offers = getTerritorialDeals(world).offers.filter((offer) => offer.proposerId === a || offer.targetId === a).slice(-8).reverse();
    const claims = getForeignClaims(world, a, b), relation = getRelation(world, a, b), crisis = relation.crisis;
    const detail = JSON.stringify([a, b, world.time.slowTick, world.territoryVersion, picked("offered"), picked("requested"), offers.map((offer) => [offer.id, offer.status]), crisis]);
    if (detail === detailKey) return; detailKey = detail;
    view("claims").innerHTML = `<p class="society-note">${esc(getNationName(world, b))}への領土請求：${claims.length}地区</p>${claims.slice(0, 10).map((claim) => `<p class="society-note"><button type="button" data-territory-action="select-claim" data-region-id="${esc(claim.regionId)}">Select ${districtName(claim.regionId)}</button> · 請求の強さ ${Math.round(claim.strength)}/100 · 過去の領有期間 ${claim.heldTicks}秒</p>`).join("") || '<p class="society-note">相手国への有力な領土請求はありません。</p>'}`;
    const offered = picked("offered"), requested = picked("requested");
    view("valuation").textContent = `選択中：譲渡${offered.length}地区、要求${requested.length}地区。相手国から見た価値：受領 ${territorialValue(world, b, offered).toFixed(0)}／譲渡 ${territorialValue(world, b, requested).toFixed(0)}. 要求地区への自国の請求：${requested.map((id) => `${districtName(id)} ${Math.round(getTerritorialClaim(world, a, id))}`).join(", ") || "なし"}.`;
    const portIssue = offered.length === 1
      ? getPortConstructionIssue(world, a, offered[0])
      : "左の一覧から自国の地区を1つ選んでください。";
    view("port").textContent = portIssue ?? `A new port in ${districtName(offered[0])} will support shipbuilding and naval routes.`;
    view("crisis").innerHTML = crisis?.demand === "territory" ? `<h3>領土を求める最後通牒</h3><p>${esc(getNationName(world, crisis.aggressorId))} demands ${(crisis.regionIds ?? []).map(districtName).join(", ")} · ${Math.max(0, crisis.deadlineSlowTick - world.time.slowTick)}s remaining.</p>${crisis.aggressorId !== a ? '<div class="society-actions"><button type="button" data-territory-action="concede">領土要求を受け入れる</button><button type="button" data-territory-action="negotiate">Negotiate · 15</button><button type="button" data-territory-action="reject">要求を拒否</button></div>' : ""}` : relation.territorialSettlement && world.time.slowTick - relation.territorialSettlement.atSlowTick < 120 && relation.treaties.some((treaty) => treaty.type === "truce" && treaty.expiresAtSlowTick === relation.territorialSettlement!.atSlowTick + 120 && treaty.expiresAtSlowTick > world.time.slowTick) ? '<p class="society-note">領土合意には休戦が伴います。破棄すると国際的な信頼が低下します。</p><button type="button" class="society-danger" data-territory-action="betray">合意を破棄して宣戦 · 20</button>' : "";
    view("offers").innerHTML = offers.map((offer) => `<article class="faction-entry"><strong>${esc(getNationName(world, offer.proposerId))} → ${esc(getNationName(world, offer.targetId))} · ${offer.status}</strong><p class="society-note">譲渡：${offer.offered.map(districtName).join(", ") || "nothing"}<br>Requests: ${offer.requested.map(districtName).join(", ") || "nothing"}</p>${offer.status === "pending" ? `<div class="society-actions">${offer.targetId === a ? `<button type="button" data-territory-action="accept" data-offer-id="${offer.id}">交換を受諾</button><button type="button" data-territory-action="decline" data-offer-id="${offer.id}">交換を拒否</button>` : `<button type="button" data-territory-action="withdraw" data-offer-id="${offer.id}">提案を撤回</button>`}</div>` : ""}</article>`).join("") || '<p class="society-note">領土提案はまだありません。</p>';
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
      feedback(success ? `Port built in ${districtName(ids[0])}.` : "安全で補給の届く沿岸地区を1つ選び、建設資材を確認してください。");
      update();
      return;
    }
    if (action === "exchange" || action === "ultimatum") {
      const offered = picked("offered"), requested = picked("requested");
      if (action === "ultimatum" && !requested.length) {
        feedback("相手国の領土を選択してください。");
        return;
      }
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
    feedback(success ? "領土操作を完了しました。領土請求、所有権、提案、履歴で結果を確認できます。" : "Cannot complete: check claims, ownership, influence, treaties, military reach, capital protection and the selected parcels.");
    update();
  });
  return { update, clearPreview };
}
