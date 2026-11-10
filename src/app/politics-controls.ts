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
      feedback(success ? "宗教政策を変更しました。" : "現在はこの政策を変更できません。");
      return;
    }
    const policy = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-governance-policy]")?.dataset.governancePolicy;
    if (policy) {
      event.stopPropagation();
      const id = selected();
      feedback(setGovernancePolicy(world, id, id, policy as GovernancePolicy) ? "統治政策を変更しました。" : "統治政策を変更できません。");
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
      feedback(success ? stopping ? "迫害命令を解除しました。" : "迫害命令を出しました。"
        : "The government cannot issue this order.");
      return;
    }
    if (!(event.target as HTMLElement).closest("[data-political-campaign]")) return;
    event.stopPropagation();
    const a = selected(), b = partner();
    const success = launchPoliticalCampaign(world, a, b);
    feedback(success ? "政治運動を開始しました。支持率はすぐに変わり、議席と政権には次の任期で反映されます。"
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
      root.innerHTML = `<h2>${democracy ? "議会制民主主義" : "君主制"}</h2>
        <p><strong>政権の思想：</strong> ${name(politics.governingIdeologyId)}</p>
        ${ban && ban.until > world.time.slowTick ? `<p><strong>禁止された運動：</strong> ${name(ban.ideologyId)} · ${ban.until - world.time.slowTick}秒残り</p>` : ""}
        ${hasPoliticalTurbulence(world) ? `<h2>領土統治</h2>
          <p>Stability ${Math.round(governance?.stability ?? 100)}/100 · Diversity ${Math.round((governance?.diversity ?? 0) * 100)}%</p>
          <p class="society-note">自治は多様な地区の統治負担を軽くします。同化は文化と宗教を徐々に変え、反発を招くことがあります。</p>
          <div class="society-actions">${(["centralized", "autonomy", "assimilation"] as const).map((policy) =>
            `<button type="button" data-governance-policy="${policy}" aria-pressed="${(governance?.policy ?? "centralized") === policy}">${policy[0]!.toUpperCase() + policy.slice(1)}</button>`).join("")}</div>` : ""}
        ${nation.populationPolicy ? `<p><strong>${populationPolicyTitle(nation.populationPolicy)}</strong> · ${nation.populationPolicy.type === "homeland" ? "同じ系統の住民が多い近隣地区を請求します。" : "最も多く信仰される宗教を国教とします。"}</p>` : ""}
        ${hasPoliticalTurbulence(world) && nation.populationPolicy?.type === "religious" ? `<h2>宗教規制</h2>
          <p class="society-note">${faithBan ? `${POPULATION_GROUPS.faith[faithBan.allowedFaith]}以外の宗教をあと${faithBan.until - world.time.slowTick}秒間禁止しています。` : "他の宗教を禁止すると国内不安や国外からの反発を招きます。"}</p>
          ${faithBan ? '<button type="button" data-religious-ban="lift">禁止を解除</button>' :
            `<button type="button" data-religious-ban="start" ${!active || (nation.nextReligiousBanAt ?? 0) > world.time.slowTick ? "disabled" : ""}>他の宗教を禁止</button>`}` : ""}
        <p class="society-note">${active ? `Next ${democracy ? "election" : "royal succession"} in ${next}s` : "Domestic politics are paused."}
        · 国の方針：${character.doctrine} · 攻撃性 ${Math.round(character.aggression * 100)}% · 協調性 ${Math.round(character.cooperation * 100)}%</p>
        <p class="society-note">${democracy ? "選挙では世論の支持を100議席に配分し、過半数を得た連立が政権を担います。" : "宮廷の支持が継承を左右します。王室の方針を変えるには対立派が8ポイント上回る必要があります。"}</p>
        <table><thead><tr><th>思想</th><th>${democracy ? "世論の支持" : "宮廷の支持"}</th>${democracy ? "<th>議席</th>" : ""}<th>役割</th></tr></thead>
        <tbody>${parties.map(([id, share]) => `<tr><td>${name(id)}</td><td>${share}%</td>${democracy ? `<td>${politics.seats.get(id) ?? 0}</td>` : ""}<td>${id === politics.governingIdeologyId ? "政権を主導" : politics.coalition.includes(id) ? "連立" : "野党"}</td></tr>`).join("")}</tbody></table>
        ${targets.length || order ? `<h2>特定集団への迫害</h2>
        <p class="society-note">強制追放は住民を通行可能な国境の外へ追い出します。大量殺害では人口が恒久的に失われます。どちらも国内不安と外交的反発を招きます。</p>
        ${order ? `<p>対象：${POPULATION_GROUPS[order.dimension][order.group]} · ${Math.max(0, order.until - world.time.slowTick)}秒残り · ${order.mode === "killing" ? `${(order.killed ?? 0).toFixed(2)}人口単位が死亡` : `${order.displaced.toFixed(2)}人口単位が避難`}.</p>
        <button type="button" data-expulsion-action="stop">迫害命令を解除</button>` : `<label>対象集団 <select data-expulsion-target>
        ${targets.map(({ dimension, group, name }) => {
          const value = `${dimension}:${group}`;
          return `<option value="${value}" ${targetGroup === value ? "selected" : ""}>${name} (${dimension})</option>`;
        }).join("")}</select></label>
        <div class="society-actions"><button type="button" data-expulsion-action="expel" ${!active || cooldown ? "disabled" : ""}>強制追放を命じる</button>
        ${hasPoliticalTurbulence(world) ? `<button type="button" data-expulsion-action="kill" ${!active || cooldown ? "disabled" : ""}>大量殺害を命じる</button>` : ""}</div>
        ${cooldown ? `<p class="society-note">あと${cooldown}秒で再実施できます。</p>` : ""}`}` : ""}
        <h2>国外への政治的働きかけ</h2>
        <p class="society-note">${esc(getNationName(world, target))}で自国政権の思想を広めます。対立する運動を支援すると外交上の緊張が高まります。</p>
        ${partnerPolitics ? `<p class="society-note">相手国の政権：${name(partnerPolitics.governingIdeologyId)} · 現地の支持率：${name(politics.governingIdeologyId)}: ${partnerPolitics.support.get(politics.governingIdeologyId) ?? 0}%.</p>` : ""}
        <button type="button" data-political-campaign ${issue ? "disabled" : ""}>Promote ${name(politics.governingIdeologyId)} · ${POLITICAL_CAMPAIGN_COST} influence</button>
        ${issue ? `<p class="society-note">${esc(issue)}</p>` : ""}`;
    },
  };
}
