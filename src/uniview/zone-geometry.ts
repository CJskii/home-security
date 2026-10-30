import { createHash } from 'node:crypto';
import { z } from 'zod';
export const vertexSchema = z.object({ X: z.number().int().min(0).max(10000), Y: z.number().int().min(0).max(10000) }).strict();
export const polygonSchema = z.array(vertexSchema).min(3).max(16);
export type Vertex = z.infer<typeof vertexSchema>;
export type Rectangle = { xMin: number; yMin: number; xMax: number; yMax: number };
export function polygonKey(points: readonly Vertex[]): string {
  if (!points.length) return '[]';
  const rotations = [points, [...points].reverse()].flatMap((list) => list.map((_, i) => JSON.stringify([...list.slice(i), ...list.slice(0, i)].map(({ X, Y }) => [X, Y]))));
  return rotations.sort()[0]!;
}
export function geometryFingerprint(points: readonly Vertex[]) { return createHash('sha256').update(polygonKey(points)).digest('hex'); }
const cross = (a: Vertex, b: Vertex, c: Vertex) => (b.X - a.X) * (c.Y - a.Y) - (b.Y - a.Y) * (c.X - a.X);
const on = (a: Vertex, b: Vertex, p: Vertex) => cross(a, b, p) === 0 && p.X >= Math.min(a.X, b.X) && p.X <= Math.max(a.X, b.X) && p.Y >= Math.min(a.Y, b.Y) && p.Y <= Math.max(a.Y, b.Y);
function intersects(a: Vertex, b: Vertex, c: Vertex, d: Vertex, proper = false) {
  const ab = cross(a, b, c), ad = cross(a, b, d), ca = cross(c, d, a), cb = cross(c, d, b);
  const strict = Math.sign(ab) * Math.sign(ad) < 0 && Math.sign(ca) * Math.sign(cb) < 0;
  return strict || !proper && (on(a, b, c) || on(a, b, d) || on(c, d, a) || on(c, d, b));
}
const edges = (points: readonly Vertex[]) => points.map((p, i) => [p, points[(i + 1) % points.length]!] as const);
export function usablePolygon(points: readonly Vertex[]): boolean {
  if (!points.every(p => vertexSchema.safeParse(p).success)) return false;
  if (points.length < 3 || points.length > 16 || new Set(points.map((p) => `${p.X},${p.Y}`)).size !== points.length) return false;
  const area = points.reduce((sum, p, i) => sum + p.X * points[(i + 1) % points.length]!.Y - p.Y * points[(i + 1) % points.length]!.X, 0);
  const sides = edges(points);
  return area !== 0 && !sides.some(([a,b],i) => sides.some(([c,d],j) => j > i && j !== i + 1 && !(i === 0 && j === sides.length - 1) && intersects(a,b,c,d)));
}
function inside(p: Vertex, points: readonly Vertex[]) {
  let result = false;
  for (const [a, b] of edges(points)) {
    if (on(a, b, p)) return true;
    if ((a.Y > p.Y) !== (b.Y > p.Y) && p.X < (b.X - a.X) * (p.Y - a.Y) / (b.Y - a.Y) + a.X) result = !result;
  }
  return result;
}
export function pointInPolygon(point: Vertex, polygon: readonly Vertex[]) { return inside(point,polygon); }
export function distanceToPolygonEdge(point: Vertex, polygon: readonly Vertex[]) {
  return Math.min(...edges(polygon).map(([a,b])=>{
    const dx=b.X-a.X,dy=b.Y-a.Y,denominator=dx*dx+dy*dy;
    const t=denominator ? Math.max(0,Math.min(1,((point.X-a.X)*dx+(point.Y-a.Y)*dy)/denominator)) : 0;
    return Math.hypot(point.X-a.X-t*dx,point.Y-a.Y-t*dy);
  }));
}
export function rectangleMembership(rect: Rectangle, polygon: readonly Vertex[]): 'WITHIN' | 'INTERSECTS' | 'OUTSIDE' {
  const corners = [{ X: rect.xMin, Y: rect.yMin }, { X: rect.xMax, Y: rect.yMin }, { X: rect.xMax, Y: rect.yMax }, { X: rect.xMin, Y: rect.yMax }];
  const pairs = edges(corners).flatMap(([a, b]) => edges(polygon).map(([c, d]) => ({ a, b, c, d })));
  if (corners.every((p) => inside(p, polygon)) && !pairs.some(({ a, b, c, d }) => intersects(a, b, c, d, true))) return 'WITHIN';
  if (corners.some((p) => inside(p, polygon)) || polygon.some((p) => p.X >= rect.xMin && p.X <= rect.xMax && p.Y >= rect.yMin && p.Y <= rect.yMax)
    || pairs.some(({ a, b, c, d }) => intersects(a, b, c, d))) return 'INTERSECTS';
  return 'OUTSIDE';
}
