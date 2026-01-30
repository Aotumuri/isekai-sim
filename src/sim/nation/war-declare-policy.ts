export const WAR_DECLARE_POLICY = {
  slowTickRange: {
    min: 5,
    max: 15,
  },
  minTotalUnits: 10,
  minUnitGap: 10,
  unitRatio: 1.4,
  evenUnitGap: 2,
  evenUnitRatio: 1.1,
  evenChance: 0.02,
  maxWarsPerTick: 5,
  amphibious: {
    minCombatShips: 1,
    minTransportShips: 1,
    navalPowerRatio: 1.2,
    landPowerRatio: 1.1,
  },
} as const;
