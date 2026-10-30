import { expect, it } from "vitest";
import { zonesSchema } from "./contracts";
import { visibleZones, zoneName, zonePoints, zoneStyle, type CameraZone } from "./zones";
function zone(slot = 0): CameraZone {
  return zonesSchema.parse({ zones: [{ id: "17b01e57-cc3d-4db5-9bdd-f7d89e8149bb", slot,
    current: { enabled: true, ruleEnabled: true, observedAt: "2026-10-19T00:00:00Z", polygon: [{ X: 0, Y: 0 }, { X: 10000, Y: 0 }, { X: 10000, Y: 10000 }, { X: 0, Y: 10000 }] } }] }).zones[0]!;
}
it("maps the independent NVR axes to the intrinsic video rather than a square container", () => {
  expect(zonePoints(zone(), 1280, 720)).toBe("0,0 1280,0 1280,720 0,720");
  expect(zoneName(zone())).toBe("Zone 0");
  expect(zoneName({ ...zone(), name: "Driveway" })).toBe("Driveway");
  expect(zoneName({ ...zone(2), name: "  " })).toBe("Zone 2");
  expect(new Set([0, 1, 2, 3].map(slot => zoneStyle(slot).color)).size).toBe(4);
});
it("hides disabled, missing, unknown-rule and malformed geometry without manufacturing points", () => {
  const good = zone();
  for (const patch of [{ enabled: false }, { ruleEnabled: false }, { ruleEnabled: null },
    { polygon: [] }, { polygon: [{ X: 0, Y: 0 }, { X: 0, Y: 0 }, { X: 0, Y: 0 }, { X: 0, Y: 0 }] },
    { polygon: [{ X: -1, Y: 0 }, { X: 10000, Y: 0 }, { X: 10000, Y: 10000 }, { X: 0, Y: 10000 }] },
    { polygon: [{ X: 0, Y: 0 }, { X: 10000, Y: 10000 }, { X: 0, Y: 10000 }, { X: 10000, Y: 0 }] },
  ]) expect(visibleZones([{ ...good, current: { ...good.current!, ...patch } }])).toEqual([]);
  expect(visibleZones([{ ...good, current: null }])).toEqual([]);
  expect(visibleZones([good, { ...good, slot: 1 }])).toHaveLength(2); // Overlaps stay separate.
});
it("renders five/six-vertex concave polygons and rejects crossings or duplicate vertices", () => {
  const five=[{X:0,Y:0},{X:10000,Y:0},{X:7000,Y:5000},{X:10000,Y:10000},{X:0,Y:10000}];
  const good={...zone(),current:{...zone().current!,polygon:five}};
  expect(visibleZones([good])).toHaveLength(1);
  expect(zonePoints(good,1280,720)).toBe("0,0 1280,0 896,360 1280,720 0,720");
  const six=[...five.slice(0,4),{X:5000,Y:10000},five[4]!];
  expect(visibleZones([{...good,current:{...good.current,polygon:six}}])).toHaveLength(1);
  expect(visibleZones([{...good,current:{...good.current,polygon:[five[0]!,five[2]!,five[4]!,five[1]!,five[3]!]}}])).toHaveLength(0);
  expect(visibleZones([{...good,current:{...good.current,polygon:[...five,five[0]!]}}])).toHaveLength(0);
});
it('uses local names before source names and never hides an uninterested enabled zone',()=>{
 const base=zone(),preference={displayName:'Local entrance',interested:false,updatedAt:'2026-10-20T17:00:00Z'};
 expect(zoneName({...base,name:'NVR area',preference})).toBe('Local entrance');expect(visibleZones([{...base,preference}])).toHaveLength(1);
 expect(zoneName({...base,name:'NVR area',preference:{...preference,displayName:null}})).toBe('NVR area');
 expect(zoneName({...base,name:null,preference:{...preference,displayName:null}})).toBe('Zone 0');
});
