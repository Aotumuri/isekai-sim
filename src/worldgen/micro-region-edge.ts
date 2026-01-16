import type { MicroRegionId } from "./micro-region";

export interface MicroRegionEdge {
  a: MicroRegionId;
  b: MicroRegionId;
  hasRiver: boolean;
}

export function createMicroRegionEdgeKey(a: MicroRegionId, b: MicroRegionId): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}
