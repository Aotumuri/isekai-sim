import type { ForeignAdvocacyExclusion, RegionalAdvocacyObservation, SimulationInstrumentation } from "../../src/sim/instrumentation";
import type { WorldState } from "../../src/sim/world-state";
import { getOwnerByMesoId } from "../../src/sim/world-cache";

const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return (sorted[Math.floor((sorted.length - 1) / 2)]! + sorted[Math.floor(sorted.length / 2)]!) / 2;
};

export function observeAdvocacyScheduling(world: WorldState) {
  interface Demand {
    id: RegionalAdvocacyObservation["id"];
    owner: RegionalAdvocacyObservation["talks"]["owner"];
    created: number;
    firstScreen?: number;
    firstDecision?: number;
    firstReview?: number;
    excluded: Partial<Record<ForeignAdvocacyExclusion, number>>;
    timely: boolean;
    closed?: number;
    closure?: string;
    screens: number;
    eligible: number;
    offers: number;
    accepted: number;
    reviewsWithBacking: number;
  }
  const demands: Demand[] = [];
  const identities = new WeakMap<RegionalAdvocacyObservation["talks"], Demand>();
  const live = new Map<Demand["id"], Demand>();
  const decisions: Record<string, number> = {};
  let cpuMicros = 0;
  const close = (demand: Demand, reason: string) => {
    demand.closed = world.time.fastTick;
    demand.closure = reason;
    live.delete(demand.id);
  };
  const instrumentation: Pick<SimulationInstrumentation, "startForeignAdvocacyMeasurement" | "observeRegionalAdvocacy"> = {
    startForeignAdvocacyMeasurement() {
      const start = process.cpuUsage();
      return () => {
        const { user, system } = process.cpuUsage(start);
        cpuMicros += user + system;
      };
    },
    observeRegionalAdvocacy(event) {
      const { id, talks } = event, day = world.time.fastTick;
      if (event.kind === "opened") {
        const previous = live.get(id);
        if (previous) close(previous, "replaced");
        const demand = { id, owner: talks.owner, created: day, timely: false, screens: 0, eligible: 0,
          offers: 0, accepted: 0, reviewsWithBacking: 0, excluded: {} };
        demands.push(demand);
        live.set(id, demand);
        identities.set(talks, demand);
        return;
      }
      const demand = identities.get(talks);
      if (!demand || demand.closed !== undefined) return;
      switch (event.kind) {
        case "closed": close(demand, talks.status); break;
        case "screened": demand.firstScreen ??= day; demand.screens++; break;
        case "eligible": demand.eligible++; break;
        case "excluded": demand.excluded[event.reason] = (demand.excluded[event.reason] ?? 0) + 1; break;
        case "review": demand.firstReview ??= day; break;
        case "offer": demand.offers++; demand.accepted += Number(event.accepted); break;
        case "governmentDecision":
          if (demand.firstDecision === undefined) {
            demand.firstDecision = day;
            demand.timely = demand.firstScreen !== undefined;
          }
          if (talks.foreign) {
            demand.reviewsWithBacking++;
            const key = `${event.withoutBacking}->${event.actual}`;
            decisions[key] = (decisions[key] ?? 0) + 1;
          }
          break;
      }
    },
  };
  return {
    instrumentation,
    sampleDay() {
      if (!live.size) return;
      const owners = getOwnerByMesoId(world);
      for (const [id, demand] of live) {
        const talks = world.regionalNegotiations?.get(id);
        if (!talks || identities.get(talks) !== demand || owners.get(id) !== demand.owner) close(demand, "invalidated");
      }
    },
    summarize() {
      const closed = demands.filter(({ closed }) => closed !== undefined);
      const screened = demands.filter(({ firstScreen }) => firstScreen !== undefined);
      return {
        created: demands.length, closed: closed.length, screened: screened.length,
        screenedBeforeFirstDecision: demands.filter(({ timely }) => timely).length,
        withGovernmentDecision: demands.filter(({ firstDecision }) => firstDecision !== undefined).length,
        screenedBeforeClosure: closed.filter(({ firstScreen }) => firstScreen !== undefined).length,
        closedUnscreened: closed.filter(({ firstScreen }) => firstScreen === undefined).length,
        medianLatency: median(screened.map(({ created, firstScreen }) => firstScreen! - created)),
        medianLifetime: median(closed.map(({ created, closed }) => closed! - created)),
        decisions, cpuMs: cpuMicros / 1000, demands,
      };
    },
  };
}
