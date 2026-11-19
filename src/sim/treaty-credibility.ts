import type { NationRuntime } from "./nation-runtime";

const RISK_HALF_LIFE = 600;
const MAX_RISK = 60;

export function treatyRisk(nation: NationRuntime, now: number): number {
  const record = nation.treatyCredibility;
  if (!record) return 0;
  return record.risk * 2 ** (-Math.max(0, now - record.lastIncidentAt) / RISK_HALF_LIFE);
}

export function recordTreatyIncident(nation: NationRuntime, now: number, severity: number): void {
  nation.treatyCredibility = {
    risk: Math.min(MAX_RISK, treatyRisk(nation, now) + severity),
    lastIncidentAt: now,
  };
}
