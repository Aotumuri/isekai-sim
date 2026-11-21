import type { NationId } from "../worldgen/nation";
import { hasTreaty, type DiplomaticRelation } from "./diplomacy";
import { DAYS_PER_SLOW_TICK } from "./time";
import { CRISIS_TRUCE_SLOW_TICKS } from "./diplomatic-time";
import { startDiplomaticWar } from "./diplomatic-crises";
import { getNationCharacter } from "./nation-character";
import type { NationRuntime } from "./nation-runtime";
import { getManualGovernmentId } from "./player-nation";
import { hasPoliticalTurbulence, recordSimulationEvent } from "./simulation-settings";
import { setSubjectFoodLevy } from "./subject-food-levy";
import { releaseSubjectGovernment, type SubjectGovernment } from "./subject-governments";
import { getSubjectIntegrationIssue, integrateSubjectGovernment } from "./territorial-governance";
import type { WorldState } from "./world-state";

type Issue = "integration" | "independence" | "self-government";
type Outcome = "proposed" | "counteroffer" | "agreed" | "rejected" | "unilateral" | "violated";
export interface SubjectDecision {
  overlordId: NationId;
  issue: Issue;
  status: Outcome;
  reviewAt: number;
  context: number[];
  reason: string;
}

export interface SubjectNegotiationContext {
  subject: NationRuntime;
  overlord: NationRuntime;
  government: SubjectGovernment;
  relation: DiplomaticRelation;
  power: number;
  footprint: number;
  shortage: number;
  canIncreaseAid: boolean;
  subjectAtWar: boolean;
  overlordAtWar: boolean;
  occupied: boolean;
  levyBurden: number;
}

function describe(world: WorldState, decision: SubjectDecision, subject: NationId) {
  recordSimulationEvent(world, { category: "politics", nationIds: [subject, decision.overlordId],
    message: `${subject} / ${decision.overlordId}: subject ${decision.issue} (${decision.status}). ${decision.reason}` });
}

function conclude(world: WorldState, subject: NationRuntime, decision: SubjectDecision, status: Outcome, reason: string) {
  decision.status = status;
  decision.reason = reason;
  decision.reviewAt = world.time.slowTick + (status === "counteroffer" ? 10 : 100);
  describe(world, decision, subject.id);
}

function assess(world: WorldState, c: SubjectNegotiationContext) {
  const { subject, overlord, government, relation, footprint, power, shortage, levyBurden } = c;
  const central = overlord.character ?? getNationCharacter(world, overlord.id);
  const local = subject.character ?? getNationCharacter(world, subject.id);
  const localIdeology = subject.politics?.governingIdeologyId ?? subject.ideologyId;
  const centralIdeology = overlord.politics?.governingIdeologyId ?? overlord.ideologyId;
  const ideologyMatch = Number(!!localIdeology && localIdeology === centralIdeology);
  const support = localIdeology ? (subject.politics?.support.get(localIdeology) ?? 50) / 100 : 0.5;
  const legitimacy = (subject.identityStability?.legitimacy ?? 100) / 100;
  const alignment = subject.governance?.alignment ?? 0;
  const grievance = subject.identityStability?.grievance ?? 0;
  const trust = relation.trust / 100;
  const pressure = (government.autonomy ?? 0) / 100;
  const charter = Number(!!government.selfGovernment);
  const centralizing = Number(centralIdeology === "cohesionism" || centralIdeology === "avian-supremacy");
  const strength = Math.min(1, power) * 0.65 + Math.min(1, footprint) * 0.35;
  const externalRisk = c.subjectAtWar ? 0.30 : 0;
  const protection = (1 - strength) * (0.23 + 0.30 * Math.max(0, overlord.warCooperation)) + externalRisk;
  const independence = pressure * 0.65 + local.aggression * 0.17 + grievance * 0.5 + levyBurden * 0.45 +
    shortage * 0.10 + strength * 0.20 - protection - trust * 0.22 - charter * 0.18;
  const release = (1 - overlord.warCooperation) * 0.47 + Number(c.overlordAtWar) * 0.17 + central.cooperation * 0.24 +
    pressure * 0.31 + strength * 0.22 - central.aggression * 0.32 - footprint * 0.16 - levyBurden * 0.45;
  const centralUnion = central.aggression * 0.33 + central.innovation * 0.17 + trust * 0.33 + alignment * 0.23 +
    ideologyMatch * 0.12 - grievance * 0.55 - footprint * 0.20 - charter * 0.18 - pressure * 0.24;
  const localUnion = protection * 0.70 + trust * 0.38 + local.cooperation * 0.25 + alignment * 0.17 +
    ideologyMatch * 0.12 + (1 - support) * 0.12 + shortage * 0.04 -
    grievance * 0.6 - charter * 0.27 - pressure * 0.4 - Number(subject.politics?.system === "democracy") * 0.07;
  const concede = central.cooperation * 0.37 + pressure * 0.28 + strength * 0.14 + trust * 0.15 -
    centralizing * 0.22 - central.aggression * 0.16 - levyBurden * 0.2;
  const context = [pressure, trust, strength, grievance, support, legitimacy, alignment, shortage * 0.5, levyBurden,
    overlord.warCooperation, Number(c.subjectAtWar), Number(c.overlordAtWar), charter, ideologyMatch, centralizing,
    Number(c.occupied), Number(c.canIncreaseAid), Number(hasTreaty(world, subject.id, overlord.id, "truce"))];
  return { independence, release, centralUnion, localUnion, concede, context, trust, pressure, legitimacy, strength, central };
}

function settleIndependence(world: WorldState, c: SubjectNegotiationContext, decision: SubjectDecision,
  terms: ReturnType<typeof assess>, negotiated: boolean) {
  const { overlord, subject, relation } = c;
  if (!releaseSubjectGovernment(world, overlord.id, subject.id)) return;
  if (negotiated) {
    const expiry = world.time.slowTick + CRISIS_TRUCE_SLOW_TICKS;
    const truce = relation.treaties.find((item) => item.type === "truce");
    if (truce) truce.expiresAtSlowTick = Math.max(truce.expiresAtSlowTick, expiry);
    else relation.treaties.push({ type: "truce", expiresAtSlowTick: expiry });
    relation.cooldownUntilSlowTick = Math.max(relation.cooldownUntilSlowTick, expiry);
    relation.tension = Math.max(0, relation.tension - 15);
    relation.crisis = null;
    conclude(world, subject, decision, "agreed", "Both governments accepted independence and a truce. The subject retained its government and assets.");
    return;
  }
  relation.trust = Math.max(0, relation.trust - 16);
  relation.tension = Math.min(100, relation.tension + 24);
  const counterattack = overlord.id !== getManualGovernmentId(world) && !c.overlordAtWar &&
    terms.central.aggression >= 0.65 && overlord.warCooperation >= 0.50 && c.power < 0.80;
  const fought = counterattack && startDiplomaticWar(world, overlord.id, subject.id);
  conclude(world, subject, decision, "unilateral", fought ?
    "The subject declared independence after talks failed. The overlord chose military intervention." :
    "The subject declared independence after talks failed. The overlord did not open a new war.");
}

export function reviewSubjectNegotiation(world: WorldState, c: SubjectNegotiationContext): void {
  const { subject, overlord, government, relation } = c;
  const now = world.time.slowTick;
  const charter = government.selfGovernment;
  if (charter && (government.foodLevy ?? 0) > charter.maximumLevy) {
    delete government.selfGovernment;
    relation.trust = Math.max(0, relation.trust - 18);
    government.autonomy = Math.min(100, (government.autonomy ?? 0) + 14);
    const decision: SubjectDecision = subject.subjectDecision = {
      overlordId: overlord.id, issue: "self-government", status: "violated", reviewAt: now + 100, context: [],
      reason: "The overlord violated the agreed ceiling on harvest obligations.",
    };
    describe(world, decision, subject.id);
    return;
  }

  const manual = getManualGovernmentId(world);
  if (manual === subject.id || manual === overlord.id) return;
  const prior = subject.subjectDecision;
  if (prior && now < prior.reviewAt) return;
  if (!prior && now < (government.establishedAtFastTick / DAYS_PER_SLOW_TICK) + 30) return;
  const terms = assess(world, c);
  const age = world.time.fastTick - government.establishedAtFastTick;
  const bilateralPeace = !c.subjectAtWar && !c.overlordAtWar && !c.occupied;
  if (prior?.status === "counteroffer" || prior?.status === "proposed") {
    resolveProposal(world, c, prior, terms, bilateralPeace);
    return;
  }

  let issue: Issue | undefined;
  if (terms.pressure >= 0.66 && terms.independence >= 0.36) issue = "independence";
  else if (!charter && terms.pressure >= 0.46 && (terms.trust < 0.74 || c.levyBurden > 0.05 || c.shortage > 0.2 || c.canIncreaseAid)) issue = "self-government";
  else if (age >= 1800 && bilateralPeace && terms.pressure < 0.55 && terms.centralUnion >= 0.52 &&
      terms.legitimacy >= 0.55 && hasPoliticalTurbulence(world)) issue = "integration";
  if (!issue) return;
  if (prior?.issue === issue && prior.context.length &&
      terms.context.every((value, index) => Math.abs(value - prior.context[index]!) < 0.15)) return;
  const reason = issue === "integration" ? "The overlord proposed union to consolidate administration and pool resources." :
    issue === "independence" ? "The subject judged political self-rule worth renegotiating the relationship." :
      "The subject sought control of domestic policy and lighter obligations.";
  const decision: SubjectDecision = subject.subjectDecision = {
    overlordId: overlord.id, issue, status: "proposed", reviewAt: now + 10, context: terms.context, reason,
  };
  describe(world, decision, subject.id);
}

function resolveProposal(world: WorldState, c: SubjectNegotiationContext, decision: SubjectDecision,
  terms: ReturnType<typeof assess>, bilateralPeace: boolean) {
  const { subject, overlord, government, relation } = c;
  if (decision.issue === "integration") {
    if (terms.localUnion < 0.59 || terms.centralUnion < 0.52 || !bilateralPeace) {
      conclude(world, subject, decision, "rejected", !bilateralPeace ?
        "War or occupation blocked ratification." :
        "The cabinets could not agree that protection and coordination outweighed the loss of self-government and the cost of union.");
      return;
    }
    government.integrationConsentAt = world.time.fastTick;
    const issue = getSubjectIntegrationIssue(world, overlord.id, subject.id);
    if (!issue && integrateSubjectGovernment(world, overlord.id, subject.id)) {
      conclude(world, subject, decision, "agreed", "Both cabinets ratified integration for security and administrative coordination.");
    } else {
      delete government.integrationConsentAt;
      conclude(world, subject, decision, "rejected", issue ?? "The territorial settlement could not be carried out.");
    }
    return;
  }

  if (decision.issue === "independence" && decision.status === "proposed" && terms.release >= 0.45 &&
      terms.independence >= 0.36 && !c.subjectAtWar && !c.occupied) {
    settleIndependence(world, c, decision, terms, true);
    return;
  }
  if (decision.issue === "independence" && decision.status === "proposed" && !government.selfGovernment && terms.concede >= 0.32) {
    conclude(world, subject, decision, "counteroffer", "The overlord refused separation and offered domestic self-government and a lower harvest levy.");
    return;
  }
  const acceptable = decision.issue === "self-government" || terms.independence < 0.64 || terms.strength < 0.42;
  if (!government.selfGovernment && terms.concede >= 0.32 && acceptable && !c.occupied) {
    const levy = world.settings?.foodEnabled === false ? 0 : government.foodLevy === 0.50 ? 0.30 :
      government.foodLevy === 0.30 ? 0.15 : 0;
    if ((government.foodLevy ?? 0) > levy) setSubjectFoodLevy(world, overlord.id, subject.id, levy);
    const extraIndustrialAid = c.canIncreaseAid;
    government.selfGovernment = { since: world.time.slowTick, maximumLevy: levy, extraIndustrialAid };
    relation.trust = Math.min(100, relation.trust + 6);
    decision.issue = "self-government";
    conclude(world, subject, decision, "agreed", "The subject accepted control of domestic policy and a binding ceiling on the harvest levy." +
      (extraIndustrialAid ? " The overlord increased its industrial aid limit, subject to reserves and transport." : ""));
    return;
  }
  if (decision.issue === "independence" && terms.independence >= 0.58 && terms.pressure >= 0.82 &&
      !c.subjectAtWar && !c.occupied && terms.strength >= (c.overlordAtWar ? 0.31 : 0.42) &&
      !hasTreaty(world, subject.id, overlord.id, "truce")) {
    settleIndependence(world, c, decision, terms, false);
    return;
  }
  relation.trust = Math.max(0, relation.trust - 5);
  conclude(world, subject, decision, "rejected", c.occupied || c.subjectAtWar ?
    "War or occupation limited the subject's ability to act on its demand." :
    "The overlord refused the demand and the subject stayed under its protection rather than risk a break.");
}
