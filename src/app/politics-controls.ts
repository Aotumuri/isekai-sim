import { endDisplacementOrder, getPersecutionTargets, startDisplacementOrder } from "../sim/forced-displacement";
import { POPULATION_GROUPS } from "../sim/regional-population";
import { populationPolicyTitle } from "../sim/population-politics";
import { getPoliticalCampaignIssue, launchPoliticalCampaign, POLITICAL_CAMPAIGN_COST } from "../sim/political-influence";
import type { NationId } from "../worldgen/nation";
import { getNationCharacter } from "../sim/nation-character";
import { getIdeologies, getNationName } from "../sim/nation-identity";
import type { NationRuntime } from "../sim/nation-runtime";
import { getNationalPolitics } from "../sim/politics";
import { endReligiousBan, getReligiousBan, startReligiousBan } from "../sim/religious-persecution";
import { getWarDeclarationMode, hasPoliticalTurbulence } from "../sim/simulation-settings";
import { setGovernancePolicy, type GovernancePolicy } from "../sim/territorial-governance";
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
  const targetByNation = new Map<NationId, string>();
  root.addEventListener("change", (event) => {
    const control = event.target as HTMLSelectElement;
    if (control.matches("[data-expulsion-target]")) targetByNation.set(selected(), control.value);
  });
  root.addEventListener("click", (event) => {
    const religiousAction = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-religious-ban]")?.dataset.religiousBan;
    if (religiousAction) {
      event.stopPropagation();
      const nation = world.nations.find(({ id }) => id === selected());
      const success = nation && (religiousAction === "lift" ? endReligiousBan(world, nation) : startReligiousBan(world, nation));
      feedback(success ? "Religious policy updated." : "The government cannot change this policy now.");
      return;
    }
    const policy = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-governance-policy]")?.dataset.governancePolicy;
    if (policy) {
      event.stopPropagation();
      const id = selected();
      feedback(setGovernancePolicy(world, id, id, policy as GovernancePolicy) ? "Governance policy updated." : "Governance policy is unavailable.");
      return;
    }
    const action = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-expulsion-action]");
    if (action) {
      event.stopPropagation();
      const nation = world.nations.find((item) => item.id === selected());
      if (!nation) return;
      const target = root.querySelector<HTMLSelectElement>("[data-expulsion-target]");
      const group = getPersecutionTargets(world, nation).find(({ dimension, group }) => `${dimension}:${group}` === target?.value);
      const stopping = action.dataset.expulsionAction === "stop";
      const killing = action.dataset.expulsionAction === "kill";
      const success = stopping ? endDisplacementOrder(world, nation) :
        !!group && startDisplacementOrder(world, nation, group.group, killing ? "killing" : "expulsion", group.dimension);
      feedback(success ? stopping ? "Persecution order ended." : "Persecution order issued."
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
      const targets = getPersecutionTargets(world, nation), order = nation.displacementOrder;
      const cooldown = Math.max(0, (nation.nextDisplacementOrderAt ?? 0) - world.time.slowTick);
      const targetGroup = targetByNation.get(nation.id);
      const parties = [...politics.support].sort((a, b) => (politics.seats.get(b[0]) ?? 0) - (politics.seats.get(a[0]) ?? 0) || b[1] - a[1]);
      const ban = politics.suppression;
      const governance = nation.governance;
      const faithBan = getReligiousBan(world, nation);
      root.innerHTML = `<h2>${democracy ? "Parliamentary democracy" : "Monarchy"}</h2>
        <p><strong>Governing ideology:</strong> ${name(politics.governingIdeologyId)}</p>
        ${ban && ban.until > world.time.slowTick ? `<p><strong>Banned movement:</strong> ${name(ban.ideologyId)} · ${ban.until - world.time.slowTick}s remaining</p>` : ""}
        ${hasPoliticalTurbulence(world) ? `<h2>Territorial governance</h2>
          <p>Stability ${Math.round(governance?.stability ?? 100)}/100 · Diversity ${Math.round((governance?.diversity ?? 0) * 100)}%</p>
          <p class="society-note">Autonomy reduces the cost of governing diverse districts. Assimilation changes culture and religion gradually and can provoke resistance.</p>
          <div class="society-actions">${(["centralized", "autonomy", "assimilation"] as const).map((policy) =>
            `<button type="button" data-governance-policy="${policy}" aria-pressed="${(governance?.policy ?? "centralized") === policy}">${policy[0]!.toUpperCase() + policy.slice(1)}</button>`).join("")}</div>` : ""}
        ${nation.populationPolicy ? `<p><strong>${populationPolicyTitle(nation.populationPolicy)}</strong> · ${nation.populationPolicy.type === "homeland" ? "Claims nearby districts with a substantial population of the homeland's ancestry." : "Recognizes the most widely practiced faith as the state religion."}</p>` : ""}
        ${hasPoliticalTurbulence(world) && nation.populationPolicy?.type === "religious" ? `<h2>Religious restrictions</h2>
          <p class="society-note">${faithBan ? `All faiths except ${POPULATION_GROUPS.faith[faithBan.allowedFaith]} are outlawed for ${faithBan.until - world.time.slowTick}s.` : "A ban on other faiths causes unrest and foreign backlash."}</p>
          ${faithBan ? '<button type="button" data-religious-ban="lift">Lift ban</button>' :
            `<button type="button" data-religious-ban="start" ${!active || (nation.nextReligiousBanAt ?? 0) > world.time.slowTick ? "disabled" : ""}>Ban all other religions</button>`}` : ""}
        <p class="society-note">${active ? `Next ${democracy ? "election" : "royal succession"} in ${next}s` : "Domestic politics are paused."}
        · Doctrine: ${character.doctrine} · Aggression ${Math.round(character.aggression * 100)}% · Cooperation ${Math.round(character.cooperation * 100)}%</p>
        <p class="society-note">${democracy ? "Elections convert public support into 100 seats. A majority coalition governs." : "Court support shapes succession. A challenger needs an eight-point lead to change royal policy."}</p>
        <table><thead><tr><th>Ideology</th><th>${democracy ? "Public support" : "Court support"}</th>${democracy ? "<th>Seats</th>" : ""}<th>Role</th></tr></thead>
        <tbody>${parties.map(([id, share]) => `<tr><td>${name(id)}</td><td>${share}%</td>${democracy ? `<td>${politics.seats.get(id) ?? 0}</td>` : ""}<td>${id === politics.governingIdeologyId ? "Leads government" : politics.coalition.includes(id) ? "Coalition" : "Opposition"}</td></tr>`).join("")}</tbody></table>
        ${targets.length || order ? `<h2>Targeted persecution</h2>
        <p class="society-note">Forced expulsion displaces residents across accessible land borders. Mass killing causes permanent population losses. Both fuel unrest and diplomatic backlash.</p>
        ${order ? `<p>Target: ${POPULATION_GROUPS[order.dimension][order.group]} · ${Math.max(0, order.until - world.time.slowTick)}s remaining · ${order.mode === "killing" ? `${(order.killed ?? 0).toFixed(2)} population units killed` : `${order.displaced.toFixed(2)} population units displaced`}.</p>
        <button type="button" data-expulsion-action="stop">End persecution order</button>` : `<label>Target group <select data-expulsion-target>
        ${targets.map(({ dimension, group, name }) => {
          const value = `${dimension}:${group}`;
          return `<option value="${value}" ${targetGroup === value ? "selected" : ""}>${name} (${dimension})</option>`;
        }).join("")}</select></label>
        <div class="society-actions"><button type="button" data-expulsion-action="expel" ${!active || cooldown ? "disabled" : ""}>Order forced expulsion</button>
        ${hasPoliticalTurbulence(world) ? `<button type="button" data-expulsion-action="kill" ${!active || cooldown ? "disabled" : ""}>Order mass killing</button>` : ""}</div>
        ${cooldown ? `<p class="society-note">Available again in ${cooldown}s.</p>` : ""}`}` : ""}
        <h2>Foreign political outreach</h2>
        <p class="society-note">Promote your governing ideology in ${esc(getNationName(world, target))}. Supporting a rival movement raises diplomatic tension.</p>
        ${partnerPolitics ? `<p class="society-note">Partner government: ${name(partnerPolitics.governingIdeologyId)} · Local support for ${name(politics.governingIdeologyId)}: ${partnerPolitics.support.get(politics.governingIdeologyId) ?? 0}%.</p>` : ""}
        <button type="button" data-political-campaign ${issue ? "disabled" : ""}>Promote ${name(politics.governingIdeologyId)} · ${POLITICAL_CAMPAIGN_COST} influence</button>
        ${issue ? `<p class="society-note">${esc(issue)}</p>` : ""}`;
    },
  };
}
