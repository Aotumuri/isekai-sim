import { foreignBackingLabel, regionalNegotiationLabel } from "../render/political-negotiation-labels";
import { getOwnerByMesoId } from "../sim/world-cache";
import { remainingDaysUntilSlowTick, slowTicksToDays } from "../sim/time";
import { endDisplacementOrder, getPersecutionTargets, startDisplacementOrder } from "../sim/forced-displacement";
import { POPULATION_DIMENSIONS, POPULATION_GROUPS } from "../sim/regional-population";
import { getRecognizedFaith, identityGroupName, type IdentityGroup } from "../sim/identity-policy";
import { getRegionalIdentityGrievance, grievanceLevel } from "../sim/identity-grievances";
import { getSubjectOverlord } from "../sim/subject-governments";
import { districtName } from "./territory-controls";
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

const DIMENSION_LABELS = { ancestry: "Ancestry", culture: "Culture", faith: "Religion" };
const ADMINISTRATION_LABELS = { centralized: "Centralized", autonomy: "Nationwide autonomy", assimilation: "Common administration" };
const percent = (share: number) => Math.round(share * 100);

function renderIdentityGovernment(world: WorldState, nation: NationRuntime): string {
  const government = nation.identityGovernment;
  if (!government) return "";
  const state = nation.identityStability;
  const id = state?.mostAffected;
  const district = id && getRegionalIdentityGrievance(world, id, nation.id);
  const recognition = POPULATION_DIMENSIONS.map((dimension) => {
    const name = identityGroupName(dimension, government.favored[dimension]);
    const exceptions = Object.entries(government.treatments[dimension]).map(([id, treatment]) =>
      `${identityGroupName(dimension, id as IdentityGroup<typeof dimension>)} (${treatment})`);
    return `<p><strong>${DIMENSION_LABELS[dimension]}</strong> · ${name}${dimension === "faith" && getRecognizedFaith(nation) !== undefined ? " (state religion)" : ""}
      ${exceptions.length ? `<br><span class="society-note">${exceptions.join(" · ")}</span>` : ""}</p>`;
  }).join("");
  const recent = government.decisions.slice(-3).reverse().map(({ day, dimension, group, action, reason }) =>
    `<li>Day ${day} · ${DIMENSION_LABELS[dimension]} · ${identityGroupName(dimension, group as IdentityGroup<typeof dimension>)} · ${action}. ${esc(reason)}</li>`).join("");
  return `<h2>Government identity and group policies</h2>${recognition}
    <p class="society-note">Groups without a listed policy are tolerated, subject to active religious bans.</p>
    ${state ? `<p>Institutional legitimacy ${Math.round(state.legitimacy)}/100 · Regional grievance ${percent(state.grievance)}/100 · Demand for local autonomy ${percent(state.autonomyDemand)}/100</p>` : ""}
    ${id && district ? `<p class="society-note">Most affected: ${esc(districtName(id))} · Grievance ${percent(grievanceLevel(district))}/100 ·
      ${district.exclusion > 0.01 ? `Main group affected: ${POPULATION_GROUPS[district.dimension][district.group]} (${DIMENSION_LABELS[district.dimension].toLowerCase()}).` : "Past grievances persist."}
      ${district.autonomyLoss > 0 ? "Recent loss of autonomy." : ""} ${district.hardship > 0.05 ? "Food shortage intensifies grievances." : ""}</p>` : ""}
    ${recent ? `<h3>Recent decisions</h3><ul>${recent}</ul>` : ""}`;
}

function renderRegionalNegotiations(world: WorldState, nation: NationRuntime): string {
  if (!world.regionalNegotiations?.size) return "";
  const owners = getOwnerByMesoId(world);
  const local = [...world.regionalNegotiations].filter(([id, talks]) => talks.owner === nation.id && owners.get(id) === nation.id);
  if (!local.length) return "";
  const rows = local.sort((a, b) => b[1].reviewAt - a[1].reviewAt).slice(0, 6).map(([id, talks]) => {
    const group = POPULATION_GROUPS[talks.dimension][talks.group];
    const occupier = world.occupation.mesoById.get(id);
    const backing = foreignBackingLabel(talks, (nationId) => getNationName(world, nationId));
    return `<li>${esc(districtName(id))} · ${esc(group)} · ${regionalNegotiationLabel(talks)}${occupier && occupier !== nation.id ? " (suspended)" : ""}. ${esc(talks.reason)}${backing ? ` <span class="society-note">${esc(backing)}</span>` : ""}</li>`;
  }).join("");
  return `<h2>Regional negotiations</h2><ul>${rows}</ul>${local.length > 6 ? `<p class="society-note">Showing six of ${local.length} districts. Hover over a district on the map to inspect its negotiations.</p>` : ""}`;
}

function renderSubjectPolitics(world: WorldState, nation: NationRuntime): string {
  const overlord = getSubjectOverlord(world, nation.id), government = overlord ? nation.subjectGovernment : undefined;
  const charter = government?.selfGovernment;
  const decisions = world.nations.flatMap((subject) => {
    const decision = subject.subjectDecision;
    if (!decision || (subject.id !== nation.id && decision.overlordId !== nation.id)) return [];
    const partner = esc(getNationName(world, subject.id === nation.id ? decision.overlordId : subject.id));
    return [{ reviewAt: decision.reviewAt,
      row: `<li>${partner} · ${decision.issue} (${decision.status}). ${esc(decision.reason)}</li>` }];
  }).sort((a, b) => b.reviewAt - a.reviewAt).slice(0, 6);
  if (!overlord && !decisions.length) return "";
  return `<h2>Subject relations</h2>
    ${overlord ? `<p>Independence pressure ${Math.round(government?.autonomy ?? 0)}/100 under ${esc(getNationName(world, overlord))}.</p>` : ""}
    ${charter ? `<p>Domestic self-government · Harvest levy capped at ${percent(charter.maximumLevy)}%${charter.extraIndustrialAid ? " · Increased industrial aid limit" : ""}</p>` : ""}
    ${decisions.length ? `<ul>${decisions.map(({ row }) => row).join("")}</ul>` : ""}`;
}

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
      const next = remainingDaysUntilSlowTick(world.time.fastTick, politics.nextMandateAt);
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
        ${ban && ban.until > world.time.slowTick ? `<p><strong>Banned movement:</strong> ${name(ban.ideologyId)} · ${remainingDaysUntilSlowTick(world.time.fastTick, ban.until)} days remaining</p>` : ""}
        ${hasPoliticalTurbulence(world) ? `<h2>Territorial governance</h2>
          <p>Stability ${Math.round(governance?.stability ?? 100)}/100 · Diversity ${Math.round((governance?.diversity ?? 0) * 100)}%</p>
          <p class="society-note">Nationwide autonomy suspends government-directed conversions. District agreements can protect specific communities or delegate control of cultural and religious institutions.</p>
          <div class="society-actions">${(["centralized", "autonomy", "assimilation"] as const).map((policy) =>
            `<button type="button" data-governance-policy="${policy}" aria-pressed="${(governance?.policy ?? "centralized") === policy}">${ADMINISTRATION_LABELS[policy]}</button>`).join("")}</div>` : ""}
        ${nation.populationPolicy ? `<p><strong>${populationPolicyTitle(nation.populationPolicy)}</strong> · ${nation.populationPolicy.type === "homeland" ? "Claims nearby districts with a substantial population of the homeland's ancestry." : "Maintains an official state religion."}</p>` : ""}
        ${renderIdentityGovernment(world, nation)}
        ${renderRegionalNegotiations(world, nation)}
        ${renderSubjectPolitics(world, nation)}
        ${hasPoliticalTurbulence(world) && getRecognizedFaith(nation) !== undefined ? `<h2>Religious restrictions</h2>
          <p class="society-note">${faithBan ? `Unprotected faiths outside ${POPULATION_GROUPS.faith[faithBan.allowedFaith]} are restricted for ${remainingDaysUntilSlowTick(world.time.fastTick, faithBan.until)} days.` : "A ban on other faiths causes unrest and foreign backlash."}</p>
          ${faithBan ? '<button type="button" data-religious-ban="lift">Lift ban</button>' :
            `<button type="button" data-religious-ban="start" ${!active || (nation.nextReligiousBanAt ?? 0) > world.time.slowTick ? "disabled" : ""}>Restrict unprotected religions</button>`}` : ""}
        <p class="society-note">${active ? `Next ${democracy ? "election" : "royal succession"} in ${next} days` : "Domestic politics are paused."}
        · Doctrine: ${character.doctrine} · Aggression ${Math.round(character.aggression * 100)}% · Cooperation ${Math.round(character.cooperation * 100)}%</p>
        <p class="society-note">${democracy ? "Elections convert public support into 100 seats. A majority coalition governs." : "Court support shapes succession. A challenger needs an eight-point lead to change royal policy."}</p>
        <table><thead><tr><th>Ideology</th><th>${democracy ? "Public support" : "Court support"}</th>${democracy ? "<th>Seats</th>" : ""}<th>Role</th></tr></thead>
        <tbody>${parties.map(([id, share]) => `<tr><td>${name(id)}</td><td>${share}%</td>${democracy ? `<td>${politics.seats.get(id) ?? 0}</td>` : ""}<td>${id === politics.governingIdeologyId ? "Leads government" : politics.coalition.includes(id) ? "Coalition" : "Opposition"}</td></tr>`).join("")}</tbody></table>
        ${targets.length || order ? `<h2>Targeted persecution</h2>
        <p class="society-note">Forced expulsion displaces residents across accessible land borders. Mass killing causes permanent population losses. Both fuel unrest and diplomatic backlash.</p>
        ${order ? `<p>Target: ${POPULATION_GROUPS[order.dimension][order.group]} · ${remainingDaysUntilSlowTick(world.time.fastTick, order.until)} days remaining · ${order.mode === "killing" ? `${(order.killed ?? 0).toFixed(2)} population units killed` : `${order.displaced.toFixed(2)} population units displaced`}.</p>
        <button type="button" data-expulsion-action="stop">End persecution order</button>` : `<label>Target group <select data-expulsion-target>
        ${targets.map(({ dimension, group, name }) => {
          const value = `${dimension}:${group}`;
          return `<option value="${value}" ${targetGroup === value ? "selected" : ""}>${name} (${dimension})</option>`;
        }).join("")}</select></label>
        <div class="society-actions"><button type="button" data-expulsion-action="expel" ${!active || cooldown ? "disabled" : ""}>Order forced expulsion</button>
        ${hasPoliticalTurbulence(world) ? `<button type="button" data-expulsion-action="kill" ${!active || cooldown ? "disabled" : ""}>Order mass killing</button>` : ""}</div>
        ${cooldown ? `<p class="society-note">Available again in ${slowTicksToDays(cooldown)} days.</p>` : ""}`}` : ""}
        <h2>Foreign political outreach</h2>
        <p class="society-note">Promote your governing ideology in ${esc(getNationName(world, target))}. Supporting a rival movement raises diplomatic tension.</p>
        ${partnerPolitics ? `<p class="society-note">Partner government: ${name(partnerPolitics.governingIdeologyId)} · Local support for ${name(politics.governingIdeologyId)}: ${partnerPolitics.support.get(politics.governingIdeologyId) ?? 0}%.</p>` : ""}
        <button type="button" data-political-campaign ${issue ? "disabled" : ""}>Promote ${name(politics.governingIdeologyId)} · ${POLITICAL_CAMPAIGN_COST} influence</button>
        ${issue ? `<p class="society-note">${esc(issue)}</p>` : ""}`;
    },
  };
}
