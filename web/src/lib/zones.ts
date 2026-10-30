import { z } from "zod";
import type { zonesSchema } from "./contracts";
export type CameraZone = z.infer<typeof zonesSchema>["zones"][number];
type Point = { X: number; Y: number };
const cross = (a: Point, b: Point, c: Point) => (b.X - a.X) * (c.Y - a.Y) - (b.Y - a.Y) * (c.X - a.X);
const on = (a: Point, b: Point, p: Point) => cross(a, b, p) === 0 && p.X >= Math.min(a.X, b.X) && p.X <= Math.max(a.X, b.X) && p.Y >= Math.min(a.Y, b.Y) && p.Y <= Math.max(a.Y, b.Y);
function intersects(a: Point, b: Point, c: Point, d: Point) {
  return Math.sign(cross(a, b, c)) * Math.sign(cross(a, b, d)) < 0 && Math.sign(cross(c, d, a)) * Math.sign(cross(c, d, b)) < 0 || on(a, b, c) || on(a, b, d) || on(c, d, a) || on(c, d, b);
}
const polygonSchema = z.array(z.object({ X: z.number().int().min(0).max(10000), Y: z.number().int().min(0).max(10000) })).min(3).max(16).refine((p) => {
  if (new Set(p.map(v => `${v.X},${v.Y}`)).size !== p.length) return false;
  const area = p.reduce((sum, v, i) => sum + v.X * p[(i + 1) % p.length]!.Y - v.Y * p[(i + 1) % p.length]!.X, 0);
  return area !== 0 && !p.some((a,i) => p.some((c,j) => j > i && j !== i + 1 && !(i === 0 && j === p.length - 1) && intersects(a,p[(i+1)%p.length]!,c,p[(j+1)%p.length]!)));
});
export const zoneName = (zone: CameraZone) => zone.preference?.displayName?.trim() || zone.name?.trim() || `Zone ${zone.slot}`;
const styles = [
  { color: "#5eead4", dash: undefined },
  { color: "#fbbf24", dash: "8 4" },
  { color: "#c4b5fd", dash: "2 4" },
  { color: "#7dd3fc", dash: "12 4 2 4" },
] as const;
export const zoneStyle = (slot: number) => styles[((slot % styles.length) + styles.length) % styles.length]!;
export function hasValidZonePolygon(zone: CameraZone) {
  return zone.current !== null && polygonSchema.safeParse(zone.current.polygon).success;
}
export function visibleZones(zones: readonly CameraZone[]) {
  return zones.filter(zone => zone.current?.enabled === true && zone.current.ruleEnabled === true && hasValidZonePolygon(zone));
}
// NVR axes are independently normalized to 10000. This is not a square pixel
// image: map into the live video's intrinsic coordinate space before SVG meet.
export function zonePoints(zone: CameraZone, width: number, height: number) {
  return zone.current!.polygon.map(p => `${p.X * width / 10000},${p.Y * height / 10000}`).join(" ");
}
