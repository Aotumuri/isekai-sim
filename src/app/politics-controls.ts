import { displacementDimension, endDisplacementOrder, startDisplacementOrder } from "../sim/forced-displacement";
import { POPULATION_GROUPS } from "../sim/regional-population";
import { populationPolicyTitle } from "../sim/population-politics";
import { getPoliticalCampaignIssue, launchPoliticalCampaign, POLITICAL_CAMPAIGN_COST } from "../sim/political-influence";
import type { NationId } from "../worldgen/nation";
import { getNationCharacter } from "../sim/nation-character";
import { getIdeologies, getNationName } from "../sim/nation-identity";
import type { NationRuntime } from "../sim/nation-runtime";
import { getNationalPolitics } from "../sim/politics";
import { getWarDeclarationMode } from "../sim/simulation-settings";
import type { WorldState } from "../sim/world-state";

const esc = (value: string) => value.replace(/[&<>"']/g, (char) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

export function attachPoliticsControls(
  root: HTMLElement,
  world: WorldState,
  selected: () => NationId,
  partner: () => NationId,
  feedback: (message: string) => void,
) {
  const targetByNation = new Map<NationId, number>();
  root.addEventListener("change", (event) => {
    const control = event.target as HTMLSelectElement;
    if (control.matches("[data-expulsion-target]")) targetByNation.set(selected(), Number(control.value));
  });
  root.addEventListener("click", (event) => {
    const action = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-expulsion-action]");
    if (action) {
      event.stopPropagation();
      const nation = world.nations.find((item) => item.id === selected());
      if (!nation) return;
      const target = root.querySelector<HTMLSelectElement>("[data-expulsion-target]");
      const stopping = action.dataset.expulsionAction === "stop";
      const success = stopping ? endDisplacementOrder(world, nation) :
        !!target && startDisplacementOrder(world, nation, Number(target.value));
      feedback(success ? stopping ? "Expulsion order ended." : "Expulsion order issued."
        : "The government cannot issue this order.");
      return;
    }
    if (!(event.target as HTMLElement).closest("[data-political-campaign]")) return;
    event.stopPropagation();
    const a = selected(), b = partner();
    const success = launchPoliticalCampaign(world, a, b);
    feedback(success ? "Political campaign launched. Support changes now; seats and government change at the next mandate."
      : getPoliticalCampaignIssue(world, a, b) ?? "The campaign could not be launched.");
  });
  return {
    update(nation: NationRuntime): void {
      if (root.contains(document.activeElement) && document.activeElement?.matches("[data-expulsion-target]")) return;
      const politics = getNationalPolitics(world, nation);
      const ideologies = new Map(getIdeologies(world).map((item) => [item.id, item.name]));
      const name = (id: string) => esc(ideologies.get(id) ?? id);
      const character = getNationCharacter(world, nation.id);
      const democracy = politics.system === "democracy";
      const active = getWarDeclarationMode(world) === "diplomacy" && nation.macroRegionIds.length > 0;
      const next = Math.max(0, politics.nextMandateAt - world.time.slowTick);
      const target = partner();
      const issue = getPoliticalCampaignIssue(world, nation.id, target);
      const partnerNation = world.nations.find((item) => item.id === target && item.macroRegionIds.length > 0);
      const partnerPolitics = partnerNation ? getNationalPolitics(world, partnerNation) : undefined;
      const dimension = displacementDimension(nation), order = nation.displacementOrder;
      const cooldown = Math.max(0, (nation.nextDisplacementOrderAt ?? 0) - world.time.slowTick);
      const targetGroup = targetByNation.get(nation.id);
      const parties = [...politics.support].sort((a, b) => (politics.seats.get(b[0]) ?? 0) - (politics.seats.get(a[0]) ?? 0) || b[1] - a[1]);
      root.innerHTML = `<h2>${democracy ? "Parliamentary democracy" : "Monarchy"}</h2>
        <p><strong>Governing ideology:</strong> ${name(politics.governingIdeologyId)}</p>
        ${nation.populationPolicy ? `<p><strong>${populationPolicyTitle(nation.populationPolicy)}</strong> · ${nation.populationPolicy.type === "homeland" ? "Claims nearby districts with a substantial population of the homeland's ancestry." : "Recognizes the most widely practiced faith as the state religion."}</p>` : ""}
        <p class="society-note">${active ? `Next ${democracy ? "election" : "royal succession"} in ${next}s` : "Domestic politics are paused."}
        · Doctrine: ${character.doctrine} · Aggression ${Math.round(character.aggression * 100)}% · Cooperation ${Math.round(character.cooperation * 100)}%</p>
        <p class="society-note">${democracy ? "Elections convert public support into 100 seats. A majority coalition governs." : "Court support shapes succession. A challenger needs an eight-point lead to change royal policy."}</p>
        <table><thead><tr><th>Ideology</th><th>${democracy ? "Public support" : "Court support"}</th>${democracy ? "<th>Seats</th>" : ""}<th>Role</th></tr></thead>
        <tbody>${parties.map(([id, share]) => `<tr><td>${name(id)}</td><td>${share}%</td>${democracy ? `<td>${politics.seats.get(id) ?? 0}</td>` : ""}<td>${id === politics.governingIdeologyId ? "Leads government" : politics.coalition.includes(id) ? "Coalition" : "Opposition"}</td></tr>`).join("")}</tbody></table>
        ${dimension || order ? `<h2>Forced expulsion</h2>
        <p class="society-note">Residents are forced across accessible land borders. Expulsions increase domestic unrest and damage relations with receiving countries.</p>
        ${order ? `<p>Target: ${POPULATION_GROUPS[order.dimension][order.group]} · ${Math.max(0, order.until - world.time.slowTick)}s remaining · ${order.displaced.toFixed(2)} population units displaced.</p>
        <button type="button" data-expulsion-action="stop">End expulsion order</button>` : dimension ? `<label>Target group <select data-expulsion-target>
        ${POPULATION_GROUPS[dimension].map((group, index) => index === nation.populationPolicy?.group ? "" :
          `<option value="${index}" ${targetGroup === index ? "selected" : ""}>${group}</option>`).join("")}</select></label>
        <button type="button" data-expulsion-action="start" ${!active || cooldown ? "disabled" : ""}>Issue 60-second expulsion order</button>
        ${cooldown ? `<p class="society-note">Available again in ${cooldown}s.</p>` : ""}` : ""}` : ""}
        <h2>Foreign political outreach</h2>
        <p class="society-note">Promote your governing ideology in ${esc(getNationName(world, target))}. Supporting a rival movement raises diplomatic tension.</p>
        ${partnerPolitics ? `<p class="society-note">Partner government: ${name(partnerPolitics.governingIdeologyId)} · Local support for ${name(politics.governingIdeologyId)}: ${partnerPolitics.support.get(politics.governingIdeologyId) ?? 0}%.</p>` : ""}
        <button type="button" data-political-campaign ${issue ? "disabled" : ""}>Promote ${name(politics.governingIdeologyId)} · ${POLITICAL_CAMPAIGN_COST} influence</button>
        ${issue ? `<p class="society-note">${esc(issue)}</p>` : ""}`;
    },
  };
}
