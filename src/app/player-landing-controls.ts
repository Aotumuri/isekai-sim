import { LANDING_PHASE_LABELS } from "../render/japanese-labels";
import type { AmphibiousCapabilityDemand } from "../sim/amphibious";
import { cancelPlayerLanding, queuePlayerLanding } from "../sim/amphibious";
import { getPlayerNation } from "../sim/player-nation";
import type { WorldState } from "../sim/world-state";
import type { MesoRegionId } from "../worldgen/meso-region";

export function attachPlayerLandingControls(
  panel: HTMLElement, world: WorldState, getDestination: () => MesoRegionId | null,
): () => void {
  const section = document.createElement("details");
  section.innerHTML = `<summary>上陸計画</summary>
    <p>自国の出港地を地図で選んで記録し、敵国の港を選択してください。</p>
    <button type="button" data-departure>選択地域を出港地にする</button>
    <p data-ports></p>
    <label>上陸部隊数 <input data-size type="number" min="1" step="1" value="1"></label>
    <label>最短出撃ティック <input data-tick type="number" min="0" step="1"></label>
    <p>複数の計画に同じティックを指定できます。準備が間に合わない部隊は準備完了後に出撃します。</p>
    <button type="button" data-queue>計画を登録</button>
    <p role="status"></p>
    <ul></ul>`;
  panel.append(section);
  const tick = section.querySelector<HTMLInputElement>("[data-tick]")!;
  const size = section.querySelector<HTMLInputElement>("[data-size]")!;
  const ports = section.querySelector<HTMLElement>("[data-ports]")!;
  const result = section.querySelector<HTMLElement>("[role=status]")!;
  const list = section.querySelector("ul")!;
  let departure: MesoRegionId | null = null;
  let actor = getPlayerNation(world);
  let key = "";
  section.querySelector<HTMLButtonElement>("[data-departure]")!.onclick = () => {
    departure = getDestination();
  };
  section.querySelector<HTMLButtonElement>("[data-queue]")!.onclick = () => {
    const target = getDestination();
    const demand = departure && target && queuePlayerLanding(world, departure, target, size.valueAsNumber,
      tick.value ? tick.valueAsNumber : world.time.fastTick);
    result.textContent = demand ? "計画を登録しました。" : "交戦中の敵港、利用可能な自軍港、部隊数、出撃時刻を確認してください。";
  };
  return () => {
    const player = getPlayerNation(world);
    if (actor !== player) {
      actor = player;
      departure = null;
      tick.value = "";
      result.textContent = "";
    }
    section.hidden = player?.commandMode !== "assisted";
    if (section.hidden || !player) return;
    tick.placeholder = String(world.time.fastTick);
    ports.textContent = `出港地 ${departure ?? "未設定"} ／ 上陸先 ${getDestination() ?? "未選択"}`;
    const operations = world.amphibiousOperations;
    const plans = operations.capabilityDemands.filter((demand) => player.landingPlanIds.has(demand.id))
      .map((demand) => ({ demand, operation: operations.operations.find((op) => op.id === demand.operationId) }));
    const next = plans.map(({ demand, operation }) => [demand.id, demand.state, demand.waitingReason, operation?.phase]).join("|");
    if (next === key) return;
    key = next;
    list.replaceChildren(...plans.map(({ demand, operation }) => {
      const item = document.createElement("li");
      const state = operation ? LANDING_PHASE_LABELS[operation.phase] : landingPreparationLabel(demand.state);
      item.textContent = `${demand.departurePortId} → ${demand.destinationPortId} · ${demand.playerPlan?.unitCount} 部隊 · ${state} `;
      if (!operation && demand.state !== "expired") {
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.textContent = "取り消す";
        cancel.onclick = () => { cancelPlayerLanding(world, demand.id); };
        item.append(cancel);
      }
      return item;
    }));
  };
}

function landingPreparationLabel(state: AmphibiousCapabilityDemand["state"]): string {
  switch (state) {
    case "waiting-transport": return "輸送船待ち";
    case "waiting-escort": return "護衛艦待ち";
    case "waiting-landing-force": return "上陸部隊待ち";
    case "ready": return "出撃可能";
    case "expired": return "終了";
    default: return "集結中";
  }
}
