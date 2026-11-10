import { getDomesticUnrest } from "../sim/domestic-unrest";
import type { NationId } from "../worldgen/nation";
import type { WorldState } from "../sim/world-state";
import { allFieldUnits, getArmyLimits, getMobilization, type MobilizationPolicy } from "../sim/mobilization";

export function attachMobilizationControls(root: HTMLElement, world: WorldState, selected: () => NationId,
  feedback: (message: string) => void): { update: () => void } {
  root.innerHTML = `<h2>陸軍と動員</h2><p class="society-note">平時は小規模な常備軍を維持します。最後通牒、周辺国の敵対、開戦によって徴兵枠が徐々に増えます。維持できる軍の規模は、戦争支持、支配下の人口、国民の負担で決まります。</p>
    <label>動員政策<select data-mobilization-policy aria-label="動員政策"><option value="automatic">自動：脅威に応じて動員</option><option value="limited">限定動員：段階的に増員</option><option value="total">総動員：国民の負担が大きい</option></select></label>
    <div data-mobilization-view="status"></div><div class="mobilization-metrics" data-mobilization-view="metrics"></div>
    <h3 data-mobilization-view="support-label">戦争支持</h3><progress data-mobilization-view="support" aria-label="戦争支持" max="100"></progress>
    <h3 data-mobilization-view="strain-label">国民の負担</h3><progress data-mobilization-view="strain" aria-label="国民の負担" max="100"></progress>
    <h3 data-mobilization-view="readiness-label">動員準備</h3><progress data-mobilization-view="readiness" aria-label="動員準備" max="100"></progress>
    <p class="society-note">平時でも多くの兵士を長期間動員すると国民の負担が増えます。戦争支持が高いほど大規模な動員を維持しやすく、救済措置で負担を軽減できます。負担が大きいと戦争支持と徴兵能力が下がります。脅威がはっきりしない場合、自動動員は国民の反発に応じて増員を抑えます。</p>
    <h3>国内安定度</h3><progress data-mobilization-view="unrest" aria-label="国内不安" max="100"></progress><p class="society-note" data-mobilization-view="unrest-status"></p>
    <h3>徴兵と復員</h3><div data-mobilization-view="history"></div>
    <p class="society-note">徴兵には人的資源、武器、補給が必要です。支持が高い大国は乗船中の部隊も含め、最大300の陸軍部隊を編成できます。支持が低下しても既存部隊は維持し、上限を超えている間は新規徴兵を停止します。海軍には別の上限があります。</p>
    <p class="society-note">自動・限定動員では、戦争や最後通牒がない状態が30秒続くと、補給の届く自国領で余剰部隊が順次復員します。生存人員は人的資源に戻り、装備は最大60%回収できます。戦時、国外、戦闘中、乗船中、作戦中の部隊は対象外です。</p>`;
  const view = (name: string) => root.querySelector<HTMLElement>(`[data-mobilization-view="${name}"]`)!;
  const policy = root.querySelector<HTMLSelectElement>("[data-mobilization-policy]")!;
  const labels = { standing: "常備軍", alert: "警戒強化", mobilizing: "戦前動員", war: "戦時動員", demobilizing: "平時規模へ縮小中" };
  const update = () => {
    const nation = world.nations.find((item) => item.id === selected()); if (!nation) return;
    const item = getMobilization(world, nation.id), limits = getArmyLimits(world, nation, item), enabled = !!world.settings?.mobilizationEnabled;
    if (document.activeElement !== policy) policy.value = item.policy;
    policy.disabled = !enabled;
    const own = allFieldUnits(world).filter((unit) => unit.nationId === nation.id || unit.volunteerOriginId === nation.id);
    const land = own.filter((unit) => unit.domain === "land").length;
    view("status").textContent = enabled ? `${labels[item.phase]} · ${item.burden >= 70 ? "国民の負担が深刻" : item.burden >= 40 ? "国民の不満が増加中" : "国民の負担は許容範囲内"}` : "動員システムは無効です。旧方式の徴兵と陸軍100部隊の上限が適用されます。";
    view("metrics").innerHTML = [["配備中の陸軍部隊", land], ["編成上限", limits.authorized], ["常備軍", limits.standing], ["現在の総動員上限", limits.maximum],
      ["民間の人的資源", Math.floor(nation.resources.manpower)], ["軍務中の人員", Math.round(own.filter((unit) => (unit.volunteerOriginId ?? unit.nationId) === nation.id).reduce((sum, unit) => sum + unit.manpower, 0))],
      ["国外に派遣中の義勇軍", own.filter((unit) => unit.volunteerOriginId === nation.id && unit.nationId !== nation.id).length],
      ["指揮下の外国義勇軍", own.filter((unit) => unit.nationId === nation.id && unit.volunteerOriginId && unit.volunteerOriginId !== nation.id).length], ["国民の負担による支持低下", `${Math.round(item.appliedSupportPenalty * 100)}%`]].map(([label, value]) => `<span>${label}<strong>${value}</strong></span>`).join("");
    view("support-label").textContent = `戦争支持 · ${Math.round(nation.warCooperation * 100)}%`;
    view("strain-label").textContent = `国民の負担 · ${item.burden.toFixed(1)}/100`;
    view("readiness-label").textContent = `動員準備 · ${Math.round(item.readiness * 100)}%`;
    (view("support") as HTMLProgressElement).value = nation.warCooperation * 100;
    (view("strain") as HTMLProgressElement).value = item.burden;
    (view("readiness") as HTMLProgressElement).value = item.readiness * 100;
    const unrest = getDomesticUnrest(world, nation.id);
    (view("unrest") as HTMLProgressElement).value = unrest.pressure;
    view("unrest-status").textContent = `国内不安：${unrest.pressure.toFixed(1)}/100 · ${unrest.phase} · 低支持の継続 ${Math.floor(unrest.lowSupportSeconds)}s. 革命には、支持の低迷が5分以上続き、危機が深まる必要があります。支持回復や講和で回避できます。${unrest.cooldownUntilSlowTick > world.time.slowTick ? ` 政治の回復期間：${Math.ceil(unrest.cooldownUntilSlowTick - world.time.slowTick)}秒。` : ""}`;
    view("history").textContent = `徴兵：${item.recruited} units· 復員：${item.demobilized} units· 帰還した人員：${Math.round(item.returnedManpower)}· 回収した武器：${item.recoveredWeapons.toFixed(1)}· 常備軍を超えた動員の継続：${Math.floor(item.continuousDeployment)}s.`;
  };
  policy.addEventListener("change", () => {
    getMobilization(world, selected()).policy = policy.value as MobilizationPolicy;
    feedback("動員政策を変更しました。次の更新から徴兵と国民の負担に反映されます。"); update();
  });
  return { update };
}
