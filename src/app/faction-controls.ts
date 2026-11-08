import type { NationId } from "../worldgen/nation";
import type { WorldState } from "../sim/world-state";
import { createFaction, getNationFaction, joinFaction, leaveFaction, setNationIdeology, type WarObligation } from "../sim/factions";
import { createIdeology, getIdeologies, getNationIdeology, getNationName } from "../sim/nation-identity";
import { getWarDeclarationMode } from "../sim/simulation-settings";
const esc = (text: unknown) => String(text).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));

export function attachFactionControls(root: HTMLElement, world: WorldState, selected: () => NationId,
  feedback: (message: string) => void): { update: () => void } {
  root.innerHTML = `<h2>Ideology and factions</h2><p class="society-note">Faction members share a map color. Ideological eligibility and the charter determine membership and war obligations.</p>
    <label>National ideology<select data-faction-control="national-ideology" aria-label="National ideology"></select></label>
    <div data-faction-view="membership"></div>
    <h2>Create a faction</h2><label>Faction name<input type="text" data-faction-control="name" aria-label="Faction name" maxlength="60" placeholder="Automatic name"></label>
    <fieldset class="faction-ideologies"><legend>Eligible ideologies</legend><div data-faction-view="ideologies"></div></fieldset>
    <div class="society-selectors"><label>When a member is attacked<select data-faction-control="defense" aria-label="Defensive obligation"><option value="mandatory">Mandatory participation</option><option value="voluntary">Voluntary participation</option><option value="none">No participation</option></select></label>
    <label>When a member attacks<select data-faction-control="offense" aria-label="Offensive obligation"><option value="none">No participation</option><option value="voluntary">Voluntary participation</option><option value="mandatory">Mandatory participation</option></select></label></div>
    <label><input type="checkbox" data-faction-control="personality" checked> Consider personality when admitting members</label>
    <p class="society-note">Mandatory calls bind all members, including reluctant and overextended nations. They can break prior treaties. Voluntary calls may be declined. Personality-based admission lets cautious nations reject risky charters; ideological eligibility always applies.</p>
    <div class="society-actions"><button type="button" data-faction-action="create">Found faction · 20 influence</button><button type="button" data-faction-action="leave">Leave faction</button></div>
    <h2>Faction directory</h2><div data-faction-view="directory"></div>
    <h2>Define an ideology</h2><div class="society-trade-form"><label>Ideology name<input type="text" data-faction-control="custom-name" aria-label="New ideology name" maxlength="40" placeholder="e.g. Maritime Federalism"></label><button type="button" data-faction-action="ideology">Add ideology</button></div>`;
  const input = (name: string) => root.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-faction-control="${name}"]`)!;
  const view = (name: string) => root.querySelector<HTMLElement>(`[data-faction-view="${name}"]`)!;
  let registryKey = "";
  const update = () => {
    const nationId = selected(); if (!world.nations.some((nation) => nation.id === nationId)) return;
    const ideologies = getIdeologies(world), next = ideologies.map((item) => item.id).join("|");
    if (registryKey !== next) {
      const old = new Set([...root.querySelectorAll<HTMLInputElement>("[data-eligible]:checked")].map((item) => item.value));
      input("national-ideology").innerHTML = ideologies.map((item) => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join("");
      view("ideologies").innerHTML = ideologies.map((item) => `<label><input type="checkbox" data-eligible value="${esc(item.id)}" ${!registryKey || old.has(item.id) ? "checked" : ""}> ${esc(item.name)}</label>`).join("");
      registryKey = next;
    }
    if (document.activeElement !== input("national-ideology")) input("national-ideology").value = getNationIdeology(world, nationId).id;
    const faction = getNationFaction(world, nationId), mode = getWarDeclarationMode(world) === "diplomacy";
    view("membership").innerHTML = faction ? `<div class="society-country"><strong>${esc(faction.name)}</strong><small>${faction.memberIds.map((id) => esc(getNationName(world, id))).join(" · ")}<br>Defense: ${faction.charter.defensiveObligation} / Offense: ${faction.charter.offensiveObligation}</small></div>` : '<p class="society-note">Non-aligned. Join a compatible faction or establish your own.</p>';
    view("directory").innerHTML = (world.factions?.factions ?? []).map((item) => `<article class="faction-entry"><strong>${esc(item.name)}</strong><p>${item.memberIds.map((id) => esc(getNationName(world, id))).join(" · ")}</p><p class="society-note">${item.charter.allowedIdeologyIds.map((id) => esc(ideologies.find((ideology) => ideology.id === id)?.name ?? id)).join(" / ")}<br>Defense: ${item.charter.defensiveObligation} · Offense: ${item.charter.offensiveObligation} · Personality-based admission: ${item.charter.considerPersonality ? "Yes" : "No"}</p><button type="button" data-faction-action="join" data-faction-id="${esc(item.id)}" ${faction || !mode ? "disabled" : ""}>Join · 5 influence</button></article>`).join("") || '<p class="society-note">No factions have been established.</p>';
    (root.querySelector('[data-faction-action="create"]') as HTMLButtonElement).disabled = !!faction || !mode;
    (root.querySelector('[data-faction-action="leave"]') as HTMLButtonElement).disabled = !faction || !mode;
  };
  root.addEventListener("change", (event) => {
    const target = event.target as HTMLSelectElement;
    if (target.dataset.factionControl !== "national-ideology") return;
    const success = setNationIdeology(world, selected(), target.value);
    feedback(success ? "National ideology updated." : "Leave your faction before adopting an ideology outside its charter."); update();
  });
  root.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-faction-action]"); if (!button) return;
    event.stopPropagation(); let success = false;
    if (button.dataset.factionAction === "create") success = !!createFaction(world, selected(), {
      allowedIdeologyIds: [...root.querySelectorAll<HTMLInputElement>("[data-eligible]:checked")].map((item) => item.value),
      defensiveObligation: input("defense").value as WarObligation, offensiveObligation: input("offense").value as WarObligation,
      considerPersonality: (input("personality") as HTMLInputElement).checked,
    }, input("name").value);
    if (button.dataset.factionAction === "leave") success = leaveFaction(world, selected());
    if (button.dataset.factionAction === "join") success = joinFaction(world, selected(), button.dataset.factionId!);
    if (button.dataset.factionAction === "ideology") success = !!createIdeology(world, input("custom-name").value);
    feedback(success ? "Faction or ideology updated." : "Requirements not met: check ideology, membership, relations, influence and personality acceptance."); update();
  });
  return { update };
}
