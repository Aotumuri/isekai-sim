import type { NationId } from "../worldgen/nation";
import type { RegionalNegotiation } from "../sim/regional-negotiations";

export function regionalNegotiationLabel(talks: RegionalNegotiation): string {
  const demand = talks.requested === "autonomous" ? "local control" : "institutional protection";
  const offer = talks.offer === "autonomous" ? "local control" : "institutional protection";
  switch (talks.status) {
    case "demand": return `Demand for ${demand}`;
    case "deferred": return `Demand for ${demand} deferred`;
    case "offer": return `Demand for ${demand}, offer of ${offer}`;
    case "agreed": return `Agreement for ${offer}`;
    case "rejected": return `Talks over ${demand} failed`;
    case "withdrawn": return `Demand for ${demand} withdrawn`;
    case "violated": return `Agreement for ${offer} violated`;
  }
}

/** Observation line for accepted foreign diplomatic support of a demand. */
export function foreignBackingLabel(talks: RegionalNegotiation, nameOf: (id: NationId) => string): string | undefined {
  const backing = talks.foreign;
  if (!backing) return undefined;
  const strength = Math.round(backing.strength * 100);
  return `Foreign support: ${nameOf(backing.sponsorId)} · ${strength}/100${backing.backlash >= 0.6 ? " · contested by the government" : ""}`;
}
