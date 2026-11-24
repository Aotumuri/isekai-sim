import type { MesoRegionId } from "../../src/worldgen/meso-region";
import type { NationId } from "../../src/worldgen/nation";
import { getInfluence, hasTreaty } from "../../src/sim/diplomacy";
import { areFactionPartners } from "../../src/sim/factions";
import type { RegionalAdvocacyObservation, SimulationInstrumentation } from "../../src/sim/instrumentation";
import { isNationActive } from "../../src/sim/nation-active";
import {
  activeSponsorships, ADVOCACY_INFLUENCE_REQUIRED, inspectAdvocacyCandidate, liveNegotiations,
  type AdvocacyEligibility,
} from "../../src/sim/political-advocacy";
import { getPoliticalContacts } from "../../src/sim/political-influence";
import type { RegionalNegotiation } from "../../src/sim/regional-negotiations";
import { getAdjacentNationPairs } from "../../src/sim/world-cache";
import type { WorldState } from "../../src/sim/world-state";

export type ReassessmentStrategy = "initial" | "threshold" | "fallback";
type Blocker = AdvocacyEligibility["blockers"][number] | "domesticSettlement" | "movementRejected";
type ObservedEligibility = Omit<AdvocacyEligibility, "blockers"> & { blockers: Blocker[] };
interface Candidate {
  initial: ObservedEligibility;
  last: ObservedEligibility;
  cleared: Set<Blocker>;
  everEligible: boolean;
  everWilling: boolean;
  recoveredWhileLive: boolean;
  recoveredWhileBlocked: boolean;
}
interface Demand {
  generation: number;
  initialTick: number;
  nextTick: number;
  candidates: Map<NationId, Candidate>;
  initialNoContact: boolean;
  gainedContact: boolean;
}
const POST_CLOSURE_TICKS = 50;
const FALLBACK_TICKS = 10;

const inactive = (reason: Blocker, influence: number): ObservedEligibility => ({
  blockers: [reason], influence, score: 0, movement: "movementRejected",
});

function currentBlockers(state: ObservedEligibility): Blocker[] {
  return state.movement === "willing" ? state.blockers : [...state.blockers, state.movement];
}

const changedEligibility = (previous: ObservedEligibility, current: ObservedEligibility) =>
  !current.blockers.length && (!!previous.blockers.length ||
    (previous.movement !== "willing" && current.movement === "willing"));

export function observeAdvocacyReassessment(world: WorldState, strategy: ReassessmentStrategy) {
  const identities = new WeakMap<RegionalNegotiation, number>();
  const active = new Map<MesoRegionId, Demand>();
  const afterClosure: { sponsor: NationId; until: number }[] = [];
  const outcomes = {
    initialScreenings: 0, observedWindows: 0, closedWindows: 0, candidateChecks: 0,
    selectionCandidates: 0, selectedDistricts: 0, newlyEligible: 0, newlyWilling: 0,
    firstGainedContacts: 0, regainedContacts: 0, noContactAtInitial: 0, noContactResolved: 0,
    targetInactive: 0, proposals: 0, accepted: 0, refused: 0, domesticRefusals: 0,
    initialDomesticRefusals: 0, initialOtherRefusals: 0,
    decisionsChanged: 0, governmentReviews: 0, relationshipChanges: 0, peakTracked: 0,
    peakClosedTracking: 0, peakCandidateTracking: 0,
    influenceCandidates: 0, influenceRecoveredLive: 0, influenceRecoveredButBlocked: 0,
    influenceRecoveredAfter: 0, influenceStillInsufficient: 0,
  };
  const initialPrimary: Partial<Record<Blocker, number>> = {};
  const initialAny: Partial<Record<Blocker, number>> = {};
  const clearedBeforeClosure: Partial<Record<Blocker, number>> = {};
  const scoreFactors: Record<string, number> = {};
  const newContactSources: Record<string, number> = {};
  const governmentChoices: Record<string, number> = {};
  const lifetimes: number[] = [];
  const samples: object[] = [];
  const supported = new WeakMap<RegionalNegotiation, { sponsorId: NationId; since: number }>();
  let generation = 0, discoveryMs = 0, discoveryCpuMicros = 0, inspectionMs = 0, observerCpuMicros = 0;
  let trackedCandidates = 0;
  const count = (counts: Record<string, number>, key: string) => { counts[key] = (counts[key] ?? 0) + 1; };
  function close(id: MesoRegionId, demand: Demand, now: number) {
    active.delete(id);
    trackedCandidates -= demand.candidates.size;
    outcomes.closedWindows++;
    lifetimes.push((now - demand.initialTick) * 10);
    for (const [sponsor, candidate] of demand.candidates) {
      for (const blocker of candidate.cleared) count(clearedBeforeClosure, blocker);
      if (!candidate.initial.blockers.includes("influence")) continue;
      if (candidate.recoveredWhileLive) outcomes.influenceRecoveredLive++;
      if (candidate.recoveredWhileBlocked) outcomes.influenceRecoveredButBlocked++;
      if (!candidate.recoveredWhileLive) afterClosure.push({ sponsor, until: now + POST_CLOSURE_TICKS });
    }
    outcomes.peakClosedTracking = Math.max(outcomes.peakClosedTracking, afterClosure.length);
  }

  function recordTransition(id: MesoRegionId, sponsor: NationId, candidate: Candidate, current: ObservedEligibility) {
    const remaining = currentBlockers(current);
    for (const blocker of currentBlockers(candidate.initial)) {
      const observed = current.factors || blocker === "noContact" || blocker === "targetInactive" ||
        blocker === "sponsorInactive";
      if (observed && !remaining.includes(blocker)) candidate.cleared.add(blocker);
    }
    if (!candidate.recoveredWhileLive && candidate.initial.blockers.includes("influence") &&
      current.influence >= ADVOCACY_INFLUENCE_REQUIRED) {
      candidate.recoveredWhileLive = true;
      candidate.recoveredWhileBlocked = current.blockers.length > 0;
      candidate.cleared.add("influence");
    }
    const previous = candidate.last;
    if (previous.blockers.includes("interest") && !current.blockers.includes("interest") && current.factors) {
      for (const [key, value] of Object.entries(current.factors)) {
        if (value !== previous.factors?.[key]) count(scoreFactors, key);
      }
      if (samples.length < 20) samples.push({ kind: "interest", id, sponsor, day: world.time.fastTick,
        before: previous.score, after: current.score, remaining: current.blockers, factorsBefore: previous.factors,
        factorsAfter: current.factors });
    }
    if (!current.blockers.length && !candidate.everEligible) {
      outcomes.newlyEligible++;
      candidate.everEligible = true;
      if (samples.length < 20) samples.push({ kind: "eligible", id, sponsor, day: world.time.fastTick,
        previous: previous.blockers, movement: current.movement });
    }
    if (!current.blockers.length && current.movement === "willing" && !candidate.everWilling) {
      outcomes.newlyWilling++;
      candidate.everWilling = true;
    }
    const changed = changedEligibility(previous, current);
    candidate.last = current;
    return changed;
  }

  function inspect(initial: readonly [MesoRegionId, RegionalNegotiation][]) {
    const now = world.time.slowTick;
    for (let i = afterClosure.length - 1; i >= 0; i--) {
      const { sponsor, until } = afterClosure[i]!;
      if (getInfluence(world, sponsor, true) >= ADVOCACY_INFLUENCE_REQUIRED) outcomes.influenceRecoveredAfter++;
      else if (now < until) continue;
      else outcomes.influenceStillInsufficient++;
      afterClosure.splice(i, 1);
    }
    if (!active.size && !initial.length) return;
    // Cache entries can be lazily rebuilt by the shared geography queries.
    // Keep those writes local while reading the same live political state.
    const view = { ...world, cache: { ...world.cache } };
    const live = liveNegotiations(view, [...active.keys()]);
    const valid = new Set(live.filter(([id, talks]) => identities.get(talks) === active.get(id)?.generation)
      .map(([id]) => id));
    for (const [id, demand] of active) if (!valid.has(id)) close(id, demand, now);
    const work = live.filter(([id]) => valid.has(id) && now >= active.get(id)!.nextTick);
    outcomes.initialScreenings += initial.length;
    if (!work.length && !initial.length) return;
    const started = performance.now();
    const discoveryCpu = process.cpuUsage();
    const contacts = getPoliticalContacts(view, new Set([...initial, ...work].map(([, talks]) => talks.owner)));
    const used = process.cpuUsage(discoveryCpu);
    discoveryCpuMicros += used.user + used.system;
    discoveryMs += performance.now() - started;
    const inspectStarted = performance.now();
    const nations = new Map(world.nations.map((nation) => [nation.id, nation]));
    const sponsorships = activeSponsorships(view);
    const selection = new Map<MesoRegionId, { talks: RegionalNegotiation; sponsors: Set<NationId> }>();
    const interval = strategy === "fallback" ? FALLBACK_TICKS : 1;

    for (const [id, talks] of initial) {
      if (active.has(id)) continue;
      identities.set(talks, ++generation);
      const demand: Demand = { generation, initialTick: now, nextTick: now + interval, candidates: new Map(),
        initialNoContact: false, gainedContact: false };
      active.set(id, demand);
      outcomes.observedWindows++;
      const owner = nations.get(talks.owner);
      if (!owner || !isNationActive(owner)) {
        outcomes.targetInactive++;
        count(initialPrimary, "targetInactive");
        count(initialAny, "targetInactive");
        continue;
      }
      for (const sponsor of [...contacts.get(talks.owner) ?? []].sort()) {
        if (sponsor === owner.id) continue;
        const nation = nations.get(sponsor);
        const state = nation
          ? inspectAdvocacyCandidate(view, id, talks, owner, nation, sponsorships)
          : inactive("sponsorInactive", 0);
        outcomes.candidateChecks++;
        if (state.blockers.includes("influence")) outcomes.influenceCandidates++;
        const blockers = currentBlockers(state);
        if (blockers[0]) count(initialPrimary, blockers[0]);
        for (const blocker of blockers) count(initialAny, blocker);
        demand.candidates.set(sponsor, { initial: state, last: state, cleared: new Set(), everEligible: !state.blockers.length,
          everWilling: !state.blockers.length && state.movement === "willing",
          recoveredWhileLive: false, recoveredWhileBlocked: false });
        trackedCandidates++;
      }
      if (!demand.candidates.size) {
        demand.initialNoContact = true;
        outcomes.noContactAtInitial++;
        count(initialPrimary, "noContact");
        count(initialAny, "noContact");
      }
    }

    for (const [id, talks] of work) {
      const demand = active.get(id)!;
      demand.nextTick = now + interval;
      const owner = nations.get(talks.owner);
      const partners = contacts.get(talks.owner);
      if (partners?.size && !demand.gainedContact && demand.initialNoContact) {
        demand.gainedContact = true;
        outcomes.noContactResolved++;
        count(clearedBeforeClosure, "noContact");
      }
      // Union preserves the failure history of contacts that temporarily disappear.
      for (const sponsor of new Set([...demand.candidates.keys(), ...partners ?? []])) {
        if (sponsor === talks.owner) continue;
        const nation = nations.get(sponsor);
        const balance = getInfluence(world, sponsor, true);
        const state = !owner || !isNationActive(owner) ? inactive("targetInactive", balance) :
          !nation || !isNationActive(nation) ? inactive("sponsorInactive", balance) :
          inspectAdvocacyCandidate(view, id, talks, owner, nation, sponsorships);
        const contact = partners?.has(sponsor) ?? false;
        if (!contact) state.blockers.unshift("noContact");
        outcomes.candidateChecks++;
        let candidate = demand.candidates.get(sponsor);
        if (!candidate) {
          outcomes.firstGainedContacts++;
          if (getAdjacentNationPairs(view).some(([a, b]) => (a === talks.owner && b === sponsor) ||
            (a === sponsor && b === talks.owner))) count(newContactSources, "border");
          if (hasTreaty(view, sponsor, talks.owner, "trade", true)) count(newContactSources, "trade");
          if (hasTreaty(view, sponsor, talks.owner, "alliance", true)) count(newContactSources, "alliance");
          if (areFactionPartners(view, sponsor, talks.owner)) count(newContactSources, "faction");
          const missing = inactive("noContact", balance);
          candidate = { initial: missing, last: missing, cleared: new Set(), everEligible: false, everWilling: false,
            recoveredWhileLive: false, recoveredWhileBlocked: false };
          demand.candidates.set(sponsor, candidate);
          trackedCandidates++;
        } else if (candidate.last.blockers.includes("noContact") && partners?.has(sponsor)) outcomes.regainedContacts++;
        if (!recordTransition(id, sponsor, candidate, state)) continue;
        outcomes.selectionCandidates++;
        if (strategy === "initial") continue;
        let selected = selection.get(id);
        if (!selected) selection.set(id, selected = { talks, sponsors: new Set() });
        selected.sponsors.add(sponsor);
      }
    }
    outcomes.selectedDistricts += selection.size;
    outcomes.peakTracked = Math.max(outcomes.peakTracked, active.size);
    outcomes.peakCandidateTracking = Math.max(outcomes.peakCandidateTracking, trackedCandidates);
    inspectionMs += performance.now() - inspectStarted;
    return selection;
  }

  function observe(event: RegionalAdvocacyObservation) {
    if (event.kind === "closed") {
      const demand = active.get(event.id);
      if (demand && identities.get(event.talks) === demand.generation) close(event.id, demand, world.time.slowTick);
    }
    if (event.kind === "offer") {
      if (!event.reassessment) {
        if (!event.accepted) outcomes[event.domesticSettlement ? "initialDomesticRefusals" : "initialOtherRefusals"]++;
        return;
      }
      outcomes.proposals++;
      outcomes.relationshipChanges += event.relationshipChanges;
      if (event.accepted) {
        supported.set(event.talks, { sponsorId: event.sponsorId, since: world.time.slowTick });
        outcomes.accepted++;
      } else {
        outcomes.refused++;
        outcomes.domesticRefusals += Number(event.domesticSettlement);
      }
    }
    if (event.kind === "governmentDecision" && event.talks.foreign) {
      const backing = supported.get(event.talks);
      if (backing?.sponsorId !== event.talks.foreign.sponsorId || backing.since !== event.talks.foreign.since) return;
      outcomes.governmentReviews++;
      count(governmentChoices, `${event.withoutBacking}->${event.actual}`);
      if (event.actual !== event.withoutBacking) outcomes.decisionsChanged++;
    }
  }

  const instrumentation: Pick<SimulationInstrumentation, "selectForeignAdvocacyReassessment" | "observeRegionalAdvocacy"> = {
    selectForeignAdvocacyReassessment(initial) {
      const cpu = active.size || initial.length || afterClosure.length ? process.cpuUsage() : undefined;
      const selection = inspect(initial);
      if (cpu) {
        const used = process.cpuUsage(cpu);
        observerCpuMicros += used.user + used.system;
      }
      return selection;
    },
    observeRegionalAdvocacy: observe,
  };
  return {
    instrumentation,
    summarize() {
      return { strategy, ...outcomes, observerCpuMs: observerCpuMicros / 1000, discoveryMs, inspectionMs,
        discoveryCpuMs: discoveryCpuMicros / 1000,
        initialPrimary, initialAny, clearedBeforeClosure, scoreFactors, newContactSources, governmentChoices, samples,
        lifetimes: [...lifetimes].sort((a, b) => a - b), windowsStillOpen: active.size,
        influenceLiveCensored: [...active.values()].reduce((total, demand) =>
          total + [...demand.candidates.values()].filter(({ initial }) => initial.blockers.includes("influence")).length, 0),
        influencePostClosureCensored: afterClosure.length };
    },
  };
}
