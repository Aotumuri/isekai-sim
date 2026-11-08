import type { NationId } from "../worldgen/nation";
import { getDiplomacyState, getRelation, hasTreaty } from "./diplomacy";
import { canRefitUnit, getDevelopedUnitWeaponCost } from "./equipment-development";
import { changeResource, findTradeRoute, getInternationalTradeState, isTradeRouteOpen, type TradeRoute } from "./international-trade";
import { getNationCharacter } from "./nation-character";
import { isNationActive } from "./nation-active";
import { getNationalDesign, type WeaponDesign } from "./research";
import { getWarDeclarationMode, recordSimulationEvent } from "./simulation-settings";
import { buildWarAdjacency, isAtWar } from "./war-state";
import type { WorldState } from "./world-state";

export interface ArmsAidShipment {
  id: string; donorId: NationId; recipientId: NationId; weapons: number; design: WeaponDesign;
  route: TradeRoute; arrivesAtSlowTick: number; status: "in-transit" | "delivered" | "returned";
}
export interface ArmsAidState {
  shipments: ArmsAidShipment[]; nextShipmentNumber: number; lastSlowTick: number; lastAISlowTick: number;
  weaponsDelivered: number; importedRefits: number; returned: number;
}
export function getArmsAidState(world: WorldState): ArmsAidState {
  return world.armsAid ??= { shipments: [], nextShipmentNumber: 0, lastSlowTick: -1,
    lastAISlowTick: -30, weaponsDelivered: 0, importedRefits: 0, returned: 0 };
}
export function canSupportNation(world: WorldState, donorId: NationId, recipientId: NationId): boolean {
  if (donorId === recipientId || getWarDeclarationMode(world) !== "diplomacy") return false;
  const wars = buildWarAdjacency(world.wars);
  if (isAtWar(donorId, recipientId, wars)) return false;
  const relation = getRelation(world, donorId, recipientId);
  const commonEnemy = [...(wars.get(donorId) ?? [])].some((enemy) => wars.get(recipientId)?.has(enemy));
  const friendly = hasTreaty(world, donorId, recipientId, "alliance") ||
    (relation.opinion >= 40 && relation.trust >= 40) || (commonEnemy && relation.opinion >= 0);
  return friendly && ![...(wars.get(recipientId) ?? [])].some((enemy) => hasTreaty(world, donorId, enemy, "alliance"));
}

export function sendArmsAid(world: WorldState, donorId: NationId, recipientId: NationId, weapons = 20): boolean {
  if (!world.settings?.armsAidEnabled || !Number.isFinite(weapons) || weapons < 5 || weapons > 50 ||
    !canSupportNation(world, donorId, recipientId)) return false;
  const donor = world.nations.find((nation) => nation.id === donorId && isNationActive(nation));
  const recipient = world.nations.find((nation) => nation.id === recipientId && isNationActive(nation));
  if (!donor || !recipient || donor.resources.weapons < weapons + 30) return false;
  const state = getArmsAidState(world);
  if (state.shipments.filter((shipment) => shipment.status === "in-transit").length >= 32 || state.shipments.some((shipment) =>
    shipment.donorId === donorId && shipment.recipientId === recipientId && shipment.status === "in-transit")) return false;
  const route = findTradeRoute(world, donorId, recipientId);
  if (!route) return false;
  const fuel = route.maritime ? Math.max(2, Math.ceil(route.regionIds.length * 0.1)) : 0;
  if (donor.resources.fuel < fuel) return false;
  changeResource(donor, "weapons", -weapons);
  if (fuel) { changeResource(donor, "fuel", -fuel); getInternationalTradeState(world).fuelSpent += fuel; }
  state.shipments.push({ id: `aid-${state.nextShipmentNumber++}`, donorId, recipientId, weapons,
    design: getNationalDesign(world, donorId), route, arrivesAtSlowTick: world.time.slowTick + Math.max(3, Math.ceil(route.regionIds.length * 1.5)), status: "in-transit" });
  recordSimulationEvent(world, { category: "aid", nationIds: [donorId, recipientId],
    message: `${donorId} sent ${weapons} weapons to ${recipientId}.` });
  return true;
}

function fieldImportedEquipment(world: WorldState, shipment: ArmsAidShipment): void {
  if (shipment.design.generation === 0) return;
  const nation = world.nations.find((item) => item.id === shipment.recipientId)!;
  let remaining = shipment.weapons;
  for (const unit of world.units.filter((item) => item.nationId === nation.id).sort((a, b) => a.id.localeCompare(b.id))) {
    if (!canRefitUnit(world, unit)) continue;
    const oldStrength = (unit.design?.firepower ?? 1) * (unit.design?.reliability ?? 1);
    if (shipment.design.firepower * shipment.design.reliability <= oldStrength * 1.02) continue;
    const cost = Math.max(1, Math.ceil(getDevelopedUnitWeaponCost(unit.type, shipment.design) * 0.5));
    if (remaining < cost || nation.resources.weapons < cost) continue;
    changeResource(nation, "weapons", -cost); remaining -= cost;
    unit.design = { ...shipment.design, levels: { ...shipment.design.levels } };
    getArmsAidState(world).importedRefits += 1;
  }
}

export function updateArmsAid(world: WorldState): void {
  const state = world.armsAid;
  if (state && state.lastSlowTick !== world.time.slowTick) {
    state.lastSlowTick = world.time.slowTick;
    for (const shipment of state.shipments.filter((item) => item.status === "in-transit")) {
      const donor = world.nations.find((nation) => nation.id === shipment.donorId), recipient = world.nations.find((nation) => nation.id === shipment.recipientId);
      if (!world.settings?.armsAidEnabled || !donor || !recipient || !isNationActive(donor) || !isNationActive(recipient) ||
        !canSupportNation(world, shipment.donorId, shipment.recipientId) || !isTradeRouteOpen(world, shipment.donorId, shipment.recipientId, shipment.route)) {
        if (donor) changeResource(donor, "weapons", shipment.weapons);
        shipment.status = "returned"; state.returned += 1;
        recordSimulationEvent(world, { category: "aid", nationIds: [shipment.donorId, shipment.recipientId], message: `${shipment.id} returned: aid route or relations unavailable.` });
      } else if (world.time.slowTick >= shipment.arrivesAtSlowTick) {
        changeResource(recipient, "weapons", shipment.weapons);
        fieldImportedEquipment(world, shipment);
        shipment.status = "delivered"; state.weaponsDelivered += shipment.weapons;
        getDiplomacyState(world).aidDeliveries += 1;
        const relation = getRelation(world, donor.id, recipient.id);
        relation.opinion = Math.min(100, relation.opinion + 5); relation.trust = Math.min(100, relation.trust + 3);
        const wars = buildWarAdjacency(world.wars);
        for (const enemy of wars.get(recipient.id) ?? []) {
          const hostileRelation = getRelation(world, donor.id, enemy);
          hostileRelation.opinion = Math.max(-100, hostileRelation.opinion - 3);
          hostileRelation.grievance = Math.min(100, hostileRelation.grievance + 2);
        }
        recordSimulationEvent(world, { category: "aid", nationIds: [donor.id, recipient.id],
          message: `${shipment.id} delivered; ${recipient.id} received weapons and access to generation ${shipment.design.generation} equipment.` });
      }
    }
    if (state.shipments.length > 100) state.shipments = [...state.shipments.filter((shipment) => shipment.status !== "in-transit").slice(-68), ...state.shipments.filter((shipment) => shipment.status === "in-transit")];
  }
  if (!world.settings?.armsAidEnabled || getWarDeclarationMode(world) !== "diplomacy") return;
  const aid = getArmsAidState(world);
  if (world.time.slowTick - aid.lastAISlowTick < 30) return;
  aid.lastAISlowTick = world.time.slowTick;
  const wars = buildWarAdjacency(world.wars);
  for (const donor of world.nations.filter(isNationActive)) {
    if (donor.resources.weapons < 70 || getNationCharacter(world, donor.id).cooperation < 0.5) continue;
    const recipient = world.nations.filter(isNationActive).filter((nation) => nation.id !== donor.id &&
      nation.resources.weapons < 20 && (wars.get(nation.id)?.size ?? 0) > 0 && canSupportNation(world, donor.id, nation.id))
      .sort((a, b) => a.resources.weapons - b.resources.weapons || a.id.localeCompare(b.id))[0];
    if (recipient) sendArmsAid(world, donor.id, recipient.id, 20);
  }
}
