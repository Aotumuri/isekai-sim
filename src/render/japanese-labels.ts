import type { UnitType } from "../sim/unit";
import type { AmphibiousPhase } from "../sim/amphibious";

export const UNIT_LABELS: Record<UnitType, string> = {
  Infantry: "歩兵", Tank: "戦車", CombatShip: "戦闘艦", TransportShip: "輸送船",
};

export const LANDING_PHASE_LABELS: Record<AmphibiousPhase, string> = {
  preparing: "準備中", embarking: "乗船中", "escort-wait": "護衛待ち",
  transporting: "航行中", landed: "上陸済み", cancelled: "中止",
};
