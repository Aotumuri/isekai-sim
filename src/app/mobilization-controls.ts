import type { NationId } from "../worldgen/nation";
import type { WorldState } from "../sim/world-state";
import { allFieldUnits, getArmyLimits, getMobilization, type MobilizationPolicy } from "../sim/mobilization";

export function attachMobilizationControls(root: HTMLElement, world: WorldState, selected: () => NationId,
  feedback: (message: string) => void): { update: () => void } {
  root.innerHTML = `<h2>Army & mobilization</h2><p class="society-note">Keep a small standing army in peacetime. Ultimatums, hostile neighbors and war gradually release more recruitment slots. War support, controlled population and public strain limit how large an army can be maintained.</p>
    <label>Mobilization policy<select data-mobilization-policy aria-label="Mobilization policy"><option value="automatic">Automatic: respond to threats</option><option value="limited">Limited: cautious prewar buildup</option><option value="total">Total mobilization: high civilian burden</option></select></label>
    <div data-mobilization-view="status"></div><div class="mobilization-metrics" data-mobilization-view="metrics"></div>
    <h3 data-mobilization-view="support-label">War support</h3><progress data-mobilization-view="support" aria-label="War support" max="100"></progress>
    <h3 data-mobilization-view="strain-label">Public strain</h3><progress data-mobilization-view="strain" aria-label="Public strain" max="100"></progress>
    <h3 data-mobilization-view="readiness-label">Mobilization readiness</h3><progress data-mobilization-view="readiness" aria-label="Mobilization readiness" max="100"></progress>
    <p class="society-note">Keeping too many soldiers in service for too long strains civilians, even during peace. High war support makes mass deployment easier to sustain. Civilian relief lowers strain; strained societies lose war support and recruitment capacity. Under ambiguous prewar warnings, automatic policy reduces the buildup as civilian opposition rises.</p>
    <h3>Recruitment & demobilization</h3><div data-mobilization-view="history"></div>
    <p class="society-note">Recruitment still costs manpower and weapons and requires supply. Large countries with strong support can field up to 300 land units, including embarked troops. Existing units stay in service if support falls; new recruitment pauses above the authorized size. Fleets keep their separate limit.</p>
    <p class="society-note">Under Automatic or Limited policy, after 30 seconds without war or an ultimatum, excess troops demobilize in small batches on supplied home territory. Surviving personnel return to the manpower pool and up to 60% of their remaining equipment is recovered. Troops at war, abroad, in combat, embarked or assigned to active operations are protected.</p>`;
  const view = (name: string) => root.querySelector<HTMLElement>(`[data-mobilization-view="${name}"]`)!;
  const policy = root.querySelector<HTMLSelectElement>("[data-mobilization-policy]")!;
  const labels = { standing: "Standing army", alert: "Heightened alert", mobilizing: "Prewar mobilization", war: "Wartime mobilization", demobilizing: "Returning to peacetime strength" };
  const update = () => {
    const nation = world.nations.find((item) => item.id === selected()); if (!nation) return;
    const item = getMobilization(world, nation.id), limits = getArmyLimits(world, nation, item), enabled = !!world.settings?.mobilizationEnabled;
    if (document.activeElement !== policy) policy.value = item.policy;
    policy.disabled = !enabled;
    const own = allFieldUnits(world).filter((unit) => unit.nationId === nation.id);
    const land = own.filter((unit) => unit.domain === "land").length;
    view("status").textContent = enabled ? `${labels[item.phase]} · ${item.burden >= 70 ? "Severe civilian strain" : item.burden >= 40 ? "Civilian discontent is rising" : "Civilian strain is manageable"}` : "Mobilization disabled: legacy recruitment and the 100-unit land limit apply.";
    view("metrics").innerHTML = [["Fielded land units", land], ["Authorized army", limits.authorized], ["Standing army", limits.standing], ["Current full-mobilization ceiling", limits.maximum],
      ["Civilian manpower pool", Math.floor(nation.resources.manpower)], ["Enlisted personnel", Math.round(own.reduce((sum, unit) => sum + unit.manpower, 0))],
      ["Strain support penalty", `${Math.round(item.appliedSupportPenalty * 100)}%`]].map(([label, value]) => `<span>${label}<strong>${value}</strong></span>`).join("");
    view("support-label").textContent = `War support · ${Math.round(nation.warCooperation * 100)}%`;
    view("strain-label").textContent = `Public strain · ${item.burden.toFixed(1)}/100`;
    view("readiness-label").textContent = `Mobilization readiness · ${Math.round(item.readiness * 100)}%`;
    (view("support") as HTMLProgressElement).value = nation.warCooperation * 100;
    (view("strain") as HTMLProgressElement).value = item.burden;
    (view("readiness") as HTMLProgressElement).value = item.readiness * 100;
    view("history").textContent = `Recruited: ${item.recruited} units · Demobilized: ${item.demobilized} units · Personnel returned: ${Math.round(item.returnedManpower)} · Weapons recovered: ${item.recoveredWeapons.toFixed(1)} · Continuous above-standing deployment: ${Math.floor(item.continuousDeployment)}s.`;
  };
  policy.addEventListener("change", () => {
    getMobilization(world, selected()).policy = policy.value as MobilizationPolicy;
    feedback("Mobilization policy updated. Recruitment and civilian strain respond on the next simulation step."); update();
  });
  return { update };
}
