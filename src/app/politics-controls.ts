import { getNationCharacter } from "../sim/nation-character";
import { getIdeologies } from "../sim/nation-identity";
import type { NationRuntime } from "../sim/nation-runtime";
import { getNationalPolitics } from "../sim/politics";
import { getWarDeclarationMode } from "../sim/simulation-settings";
import type { WorldState } from "../sim/world-state";

const esc = (value: string) => value.replace(/[&<>"']/g, (char) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

export function attachPoliticsControls(root: HTMLElement, world: WorldState) {
  return {
    update(nation: NationRuntime): void {
      const politics = getNationalPolitics(world, nation);
      const ideologies = new Map(getIdeologies(world).map((item) => [item.id, item.name]));
      const name = (id: string) => esc(ideologies.get(id) ?? id);
      const character = getNationCharacter(world, nation.id);
      const democracy = politics.system === "democracy";
      const active = getWarDeclarationMode(world) === "diplomacy" && nation.macroRegionIds.length > 0;
      const next = Math.max(0, politics.nextMandateAt - world.time.slowTick);
      const parties = [...politics.support].sort((a, b) => (politics.seats.get(b[0]) ?? 0) - (politics.seats.get(a[0]) ?? 0) || b[1] - a[1]);
      root.innerHTML = `<h2>${democracy ? "Parliamentary democracy" : "Monarchy"}</h2>
        <p><strong>Governing ideology:</strong> ${name(politics.governingIdeologyId)}</p>
        <p class="society-note">${active ? `Next ${democracy ? "election" : "royal succession"} in ${next}s` : "Domestic politics are paused."}
        · Doctrine: ${character.doctrine} · Aggression ${Math.round(character.aggression * 100)}% · Cooperation ${Math.round(character.cooperation * 100)}%</p>
        <p class="society-note">${democracy ? "Elections convert public support into 100 seats. A majority coalition governs." : "Court support shapes succession. A challenger needs an eight-point lead to change royal policy."}</p>
        <table><thead><tr><th>Ideology</th><th>${democracy ? "Public support" : "Court support"}</th>${democracy ? "<th>Seats</th>" : ""}<th>Role</th></tr></thead>
        <tbody>${parties.map(([id, share]) => `<tr><td>${name(id)}</td><td>${share}%</td>${democracy ? `<td>${politics.seats.get(id) ?? 0}</td>` : ""}<td>${id === politics.governingIdeologyId ? "Leads government" : politics.coalition.includes(id) ? "Coalition" : "Opposition"}</td></tr>`).join("")}</tbody></table>`;
    },
  };
}
