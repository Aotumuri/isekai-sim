import type { NationId } from "../worldgen/nation";
import type { WorldState } from "../sim/world-state";
import { getNationName } from "../sim/nation-identity";
import { getMapView, selectMapNation, setMapMode } from "../render/map-view-state";
const esc = (value: unknown) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));

export function attachExileControls(root: HTMLElement, world: WorldState, selected: () => NationId,
  choose: (id: NationId) => void): { update: () => void } {
  root.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-exile-nation]"); if (!button) return;
    event.stopPropagation(); const id = button.dataset.exileNation as NationId;
    choose(id);
    if (button.dataset.exileAction === "claims") {
      selectMapNation(world, id); setMapMode(world, "claims"); getMapView(world).revision++;
    }
  });
  return { update: () => {
    const id = selected(), record = world.exileGovernments?.byNationId.get(id);
    const hosted = [...(world.exileGovernments?.byNationId.values() ?? [])].filter((item) => item.status === "exiled" && item.hostId === id);
    const n = (value: NationId) => esc(getNationName(world, value));
    root.innerHTML = `${record ? `<article class="society-country society-exile"><strong>${record.status === "exiled" ? "亡命政府" : record.status === "restored" ? "政府が帰還" : "亡命政府が解散"}</strong>
      <small>受入国： ${n(record.hostId)} · Homeland: ${record.homelandIds.length} districts · Restored: ${record.restoredDistricts}<br>
      Free forces: ${world.units.filter((unit) => unit.exileOriginId === id).length}部隊が同盟国の指揮下 · ${record.reserveUnits.length}部隊が移動中</small>
      <p class="society-note">${record.status === "exiled" ? "領土を失うと徴兵と生産は停止します。信頼できる同盟国が解放戦争を継続します。解放した本国領は自動で返還され、生き残った亡命軍は政府と共に帰還します。" : record.status === "restored" ? "政府は本国に帰還しました。亡命軍は戦闘や命令が終了すると同盟国の指揮を離れ、自国の徴兵が再開します。" : "解放戦争を継続できる、信頼できる同盟国がありませんでした。"}</p>
      <button type="button" data-exile-nation="${esc(id)}" data-exile-action="claims">本国への領土請求を見る · C</button></article>` : ""}
      ${hosted.length ? `<details open><summary>受け入れた亡命政府 · ${hosted.length}</summary>${hosted.map((item) => `<p>${n(item.nationId)} · ${item.evacuatedUnits}部隊が脱出 <button type="button" data-exile-nation="${esc(item.nationId)}">政府を確認</button></p>`).join("")}</details>` : ""}`;
  } };
}
