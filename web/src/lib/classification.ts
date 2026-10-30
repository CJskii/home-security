import type { SecurityEvent } from "./contracts";
export type DisplayCategory =
  | "Person"
  | "Car"
  | "Van"
  | "Truck"
  | "Bus"
  | "Motorcycle"
  | "Bicycle"
  | "Motor vehicle"
  | "Non-motor vehicle"
  | "Unknown";
type SourceObject = SecurityEvent["objects"][number];
const vehicleLabels: Record<string, DisplayCategory> = {
  car: "Car",
  suv: "Car",
  van: "Van",
  truck: "Truck",
  bus: "Bus",
  motorcycle: "Motorcycle",
  bicycle: "Bicycle",
};
export function objectCategory(
  object: Pick<SourceObject, "category" | "analysis">,
): DisplayCategory {
  if (object.category === "person") return "Person";
  const fallback =
    object.category === "motor_vehicle"
      ? "Motor vehicle"
      : object.category === "non_motor_vehicle"
        ? "Non-motor vehicle"
        : "Unknown";
  const analysis = object.analysis;
  if (
    fallback === "Unknown" ||
    !analysis ||
    analysis.verification === "contradicted" ||
    !["motor_vehicle", "non_motor_vehicle"].includes(analysis.observedType)
  )
    return fallback;
  const type = analysis.vehicle?.vehicleType;
  return typeof type === "string" && Object.hasOwn(vehicleLabels, type)
    ? vehicleLabels[type]!
    : fallback;
}
export function eventCategories(event: SecurityEvent): DisplayCategory[] {
  // Prefer image-associated observations for the compact label when Alarm and Structure
  // both report the same broad category. Keep all exact observations in event details.
  const objects = event.objects.filter(
    (object) =>
      object.sourceList !== "RelatedObjects.ObjectList" ||
      object.images.cropId ||
      object.images.fullFrameId ||
      !event.objects.some(
        (other) =>
          other.category === object.category &&
          other.sourceList.startsWith("StructureInfo.") &&
          (other.images.cropId || other.images.fullFrameId),
      ),
  );
  const labels = objects.map(objectCategory);
  for (const category of event.categories)
    if (!objects.some((o) => o.category === category))
      labels.push(objectCategory({ category, analysis: null }));
  return [...new Set(labels.length ? labels : ["Unknown" as const])];
}
