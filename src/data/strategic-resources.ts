export const STRATEGIC_RESOURCES = ["copper", "rubber", "tungsten"] as const;
export type StrategicResource = typeof STRATEGIC_RESOURCES[number];

export const STRATEGIC_RESOURCE_NAMES: Record<StrategicResource, string> = {
  copper: "銅",
  rubber: "ゴム",
  tungsten: "タングステン",
};

export function isStrategicResource(resource: unknown): resource is StrategicResource {
  return STRATEGIC_RESOURCES.some((key) => key === resource);
}
