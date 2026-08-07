export type SimulationMetricName =
  | "repositionUnits"
  | "assignment.rebuild"
  | "assignment.defense"
  | "assignment.attack"
  | "movement.progression"
  | "pathfinding.bfs"
  | "updateOccupation"
  | "updateCapitals"
  | "surrender";

export type SimulationCounterName =
  | "pathfinding.bfs"
  | "pathfinding.bfsFound"
  | "pathfinding.bfsUnreachable"
  | "pathfinding.exploredRegions"
  | "pathfinding.shared.requests"
  | "pathfinding.shared.hits"
  | "pathfinding.shared.misses"
  | "pathfinding.shared.fieldsCreated"
  | "pathfinding.shared.fieldsDiscarded"
  | "pathfinding.shared.entriesBuilt"
  | "pathfinding.shared.invalidations"
  | "pathfinding.shared.invalidation.map"
  | "pathfinding.shared.invalidation.territory"
  | "pathfinding.shared.invalidation.occupation"
  | "pathfinding.shared.invalidation.building"
  | "pathfinding.shared.invalidation.wars"
  | "target.reassignments"
  | "movement.regionArrivals"
  | "occupation.fullRegionScans"
  | "occupation.regionsScanned"
  | "capitals.activeNationScans"
  | "world.occupationChanges"
  | "world.territoryChanges";

/**
 * Optional benchmark observer. Production worlds do not install one, so hot paths
 * only pay for an undefined property check and never call performance.now().
 */
export interface SimulationInstrumentation {
  recordDuration(name: SimulationMetricName, durationMs: number): void;
  incrementCounter(name: SimulationCounterName, amount?: number): void;
}
