import { expect, it } from "vitest";
import { eventCategories, objectCategory } from "./classification";
import type { SecurityEvent } from "./contracts";
function object(
  category: string,
  type: string | null,
  image = true,
): SecurityEvent["objects"][number] {
  return {
    id: crypto.randomUUID(),
    category,
    sourceList: "StructureInfo.ObjInfo.VehicleInfoList",
    images: {
      cropId: image ? "crop" : null,
      fullFrameId: image ? "frame" : null,
    },
    rectangle: null,
    analysis:
      type === null
        ? null
        : {
            observedType: "motor_vehicle",
            verification: "uncertain",
            actions: ["visible"],
            uncertainties: [],
            vehicle: { vehicleType: type },
            person: null,
          },
  };
}
it("maps only supported AI vehicle traits and retains authoritative fallbacks", () => {
  for (const [type, label] of Object.entries({
    car: "Car",
    suv: "Car",
    van: "Van",
    truck: "Truck",
    bus: "Bus",
    motorcycle: "Motorcycle",
    bicycle: "Bicycle",
  }))
    expect(objectCategory(object("motor_vehicle", type))).toBe(label);
  for (const type of [null, "other", "unknown", "lorry", "constructor", "__proto__"]) {
    expect(objectCategory(object("motor_vehicle", type))).toBe("Motor vehicle");
    expect(objectCategory(object("non_motor_vehicle", type))).toBe(
      "Non-motor vehicle",
    );
  }
  expect(objectCategory(object("person", "car"))).toBe("Person");
  const disputed = object("motor_vehicle", "car");
  disputed.analysis!.verification = "contradicted";
  expect(objectCategory(disputed)).toBe("Motor vehicle");
});
it("keeps mixed and unrefined Structure observations while compacting redundant Alarm category labels", () => {
  const objects = [
    object("motor_vehicle", null, false),
    object("motor_vehicle", "car"),
    object("motor_vehicle", "van"),
    object("motor_vehicle", null, false),
    object("person", null),
  ];
  objects[0]!.sourceList = "RelatedObjects.ObjectList";
  const event = {
    objects,
    categories: ["motor_vehicle", "person"],
  } as SecurityEvent;
  const before = JSON.stringify(objects);
  expect(eventCategories(event)).toEqual([
    "Car",
    "Van",
    "Motor vehicle",
    "Person",
  ]);
  expect(JSON.stringify(objects)).toBe(before);
  expect(objects).toHaveLength(5);
  expect(
    eventCategories({
      objects: [],
      categories: ["non_motor_vehicle"],
    } as unknown as SecurityEvent),
  ).toEqual(["Non-motor vehicle"]);
});
