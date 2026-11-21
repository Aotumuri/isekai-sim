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
