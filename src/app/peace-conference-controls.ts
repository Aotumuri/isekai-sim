import { getNationName } from "../sim/nation-identity";
import { getConferenceWars, openPeaceConference, respondToPeaceConference } from "../sim/peace-conference";
import type { WorldState } from "../sim/world-state";
import type { NationId } from "../worldgen/nation";

export function attachPeaceConferenceControls(root: HTMLElement, world: WorldState,
  selected: () => NationId, partner: () => NationId, feedback: (message: string) => void) {
  root.innerHTML = `<h2>Joint peace conference</h2><p class="society-note" data-conference-status></p>
    <div class="society-actions"><button type="button" data-conference-action="open">Invite both sides</button>
    <button type="button" data-conference-action="accept">Consent to joint peace</button>
    <button type="button" data-conference-action="decline">Decline / withdraw</button></div>`;
  const status = root.querySelector<HTMLElement>("[data-conference-status]")!;
  const button = (name: string) => root.querySelector<HTMLButtonElement>(`[data-conference-action="${name}"]`)!;
  let activeId: number | undefined;

  function update(): void {
    const id = selected(), target = partner();
    const conferences = world.peaceConferences?.filter((item) => item.participants.includes(id)) ?? [];
    const active = conferences.find((item) => item.participants.includes(target)) ?? conferences[0];
    const wars = active ? [] : getConferenceWars(world, id, target);
    activeId = active?.id;
    root.hidden = !active && wars.length < 2;
    if (root.hidden) return;
    button("open").hidden = !!active;
    button("accept").hidden = button("decline").hidden = !active;
    button("accept").disabled = !!active?.approvals.has(id);
    const name = (nation: NationId) => getNationName(world, nation);
    const invited = [...new Set(wars.flatMap((war) => [war.nationAId, war.nationBId]))];
    status.textContent = active
      ? `${active.wars.length} wars · ${Math.max(0, active.expiresAt - world.time.slowTick)}s left. ${active.participants.map((nation) =>
        `${name(nation)} (${active.approvals.has(nation) ? "consented" : "pending"})`).join(", ")}. Terms: return occupations and sign a five-minute truce in every listed war.`
      : `Invite ${invited.map(name).join(", ")} to settle ${wars.length} wars. Every participant must consent to status-quo peace. Other wars continue.`;
  }

  button("open").addEventListener("click", () => {
    feedback(openPeaceConference(world, selected(), partner()) ? "Joint peace invitations sent." : "These wars cannot join a new conference.");
    update();
  });
  for (const [action, accept] of [["accept", true], ["decline", false]] as const) button(action).addEventListener("click", () => {
    if (activeId === undefined) return;
    const accepted = respondToPeaceConference(world, activeId, selected(), accept);
    const stillOpen = world.peaceConferences?.some((item) => item.id === activeId);
    feedback(accepted ? accept ? stillOpen ? "Consent recorded." : "Joint peace signed." : "Conference declined." : "This conference is no longer available.");
    update();
  });
  return { update };
}
