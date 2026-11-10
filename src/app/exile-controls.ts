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
    root.innerHTML = `${record ? `<article class="society-country society-exile"><strong>${record.status === "exiled" ? "Government in exile" : record.status === "restored" ? "Government restored" : "Exile government dissolved"}</strong>
      <small>Host: ${n(record.hostId)} · Homeland: ${record.homelandIds.length} districts · Restored: ${record.restoredDistricts}<br>
      Free forces: ${world.units.filter((unit) => unit.exileOriginId === id).length} under allied command · ${record.reserveUnits.length} in transit</small>
      <p class="society-note">${record.status === "exiled" ? "National recruitment and production cease without territory. A trusted ally continues the liberation war. Liberated homeland is returned automatically; surviving free forces follow the government home." : record.status === "restored" ? "The government has returned home. Free forces leave allied command when clear of combat and active orders; national recruitment resumes." : "No trusted ally remained able to continue the liberation war."}</p>
      <button type="button" data-exile-nation="${esc(id)}" data-exile-action="claims">View homeland claims · C</button></article>` : ""}
      ${hosted.length ? `<details open><summary>Hosted governments in exile · ${hosted.length}</summary>${hosted.map((item) => `<p>${n(item.nationId)} · ${item.evacuatedUnits} units evacuated <button type="button" data-exile-nation="${esc(item.nationId)}">Inspect government</button></p>`).join("")}</details>` : ""}`;
  } };
}
