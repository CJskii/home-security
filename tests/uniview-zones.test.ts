import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { geometryFingerprint, rectangleMembership, usablePolygon } from '../src/uniview/zone-geometry.js';
import { observedZones, triggeringMatch, observedAtTime } from '../src/uniview/zones.js';
import { at, configuration, installation, square, zoneDatabase } from './zone-fixtures.js';
it('discovers all four slots on both cameras including disabled configuration', async () => {
  const f = zoneDatabase();
  for (const channel of [1, 2]) await f.store.observe(installation, channel, observedZones(configuration()), at(0));
  expect(f.state().zones).toHaveLength(8); expect(f.state().versions).toHaveLength(8);
  expect(f.versions().filter((v) => !v.enabled)).toHaveLength(2);
  expect(f.versions().every((v) => v.observedAt.getTime() === at(0).getTime())).toBe(true);
});
it('unchanged and reordered polygons extend observations without creating new versions', async () => {
  const f = zoneDatabase(), config = configuration();
  await f.store.observe(installation, 1, observedZones(config), at(0));
  config.Areas.PolygonInfoList.forEach((s) => { s.PointList = [...s.PointList.slice(2), ...s.PointList.slice(0, 2)].reverse(); });
  await f.store.observe(installation, 1, observedZones(config), at(24));
  expect(f.state().versions).toHaveLength(4);
  expect(f.versions()[0]).toMatchObject({ observedAt: at(0), lastObservedAt: at(24) });
});
it('geometry, enabled and global-rule changes produce new immutable versions', async () => {
  const f = zoneDatabase(), config = configuration();
  await f.store.observe(installation, 1, observedZones(config), at(0));
  await f.store.observe(installation, 1, observedZones(config), at(24));
  const original = structuredClone(f.state().versions[0]);
  config.Areas.PolygonInfoList[0]!.PointList = square(500, 9500);
  config.Areas.PolygonInfoList[1]!.Enabled = 0;
  await f.store.observe(installation, 1, observedZones(config), at(48));
  expect(f.state().versions).toHaveLength(6);
  expect(f.state().versions[0]).toEqual(original);
  config.Rule.Enabled = 0;
  await f.store.observe(installation, 1, observedZones(config), at(72));
  expect(f.state().versions).toHaveLength(10);
});
it('local names and prior versions survive rename and slot reuse', async () => {
  const f = zoneDatabase(), config = configuration();
  await f.store.observe(installation, 1, observedZones(config), at(0));
  await f.store.observe(installation, 1, observedZones(config), at(24));
  const old = f.versions()[0]!;
  await f.store.rename(installation, 1, 0, 'Driveway', at(25));
  const renamed = f.versions().at(-1)!;
  expect(renamed).toMatchObject({ displayName: 'Driveway', observedAt: at(24), lastObservedAt: at(24), nameEffectiveAt: at(25) });
  expect(observedAtTime(renamed, at(25))).toBe(false); // Rename is not an NVR observation.
  await f.store.observe(installation, 1, observedZones(config), at(48));
  expect(f.state().versions).toHaveLength(5);
  expect(triggeringMatch(square(), f.versions(), at(12))).toMatchObject({ zoneVersionId: old.id });
  expect(triggeringMatch(square(), f.versions(), at(30))).toMatchObject({ zoneVersionId: renamed.id });
  config.Areas.PolygonInfoList[0]!.PointList = square(600, 9000);
  await f.store.observe(installation, 1, observedZones(config), at(72));
  expect(f.versions().at(-1)!.displayName).toBe('Driveway');
  expect(f.versions()[0]!.displayName).toBe('Channel 1 zone 0');
  await f.store.rename(installation, 1, 0, 'Driveway', at(73));
  expect(f.state().versions).toHaveLength(6);
  expect((await f.store.list(installation, 1))[0]!.displayName).toBe('Driveway');
});
it('does not infer disabled state for omitted slots or accept duplicate/malformed polygons', async () => {
  const f = zoneDatabase(), full = configuration();
  await f.store.observe(installation, 1, observedZones(full), at(0));
  const partial = { ...full, Areas: { Num: 1, PolygonInfoList: [full.Areas.PolygonInfoList[0]!] } };
  await f.store.observe(installation, 1, observedZones(partial), at(24));
  expect(f.versions()[1]!.lastObservedAt).toEqual(at(0));
  expect(f.versions()[1]!.enabled).toBe(true);
  expect(() => observedZones({ ...partial, Areas: { Num: 2, PolygonInfoList: [partial.Areas.PolygonInfoList[0]!, partial.Areas.PolygonInfoList[0]!] } })).toThrow();
  const bad = configuration(); bad.Areas.PolygonInfoList[0]!.PointList = square().map(() => ({ X: 1, Y: 1 }));
  expect(() => observedZones(bad)).toThrow();
});
it('handles empty disabled slots without inventing geometry', async () => {
  const config = configuration(); config.Areas.PolygonInfoList[3]!.PointNum = 0; config.Areas.PolygonInfoList[3]!.PointList = [];
  const f = zoneDatabase(); await f.store.observe(installation, 1, observedZones(config), at(0));
  expect(f.versions()[3]!.polygon).toEqual([]);
});
it('matches polygons regardless of starting vertex or winding but not different adjacency', () => {
  const polygon = square();
  expect(geometryFingerprint(polygon)).toBe(geometryFingerprint([...polygon.slice(1), polygon[0]!].reverse()));
  expect(usablePolygon([polygon[0]!, polygon[2]!, polygon[1]!, polygon[3]!])).toBe(false);
});
it('makes overlapping memberships independent of unique triggering-rule geometry', async () => {
  const f = zoneDatabase(); await f.store.observe(installation, 1, observedZones(configuration()), at(0));
  await f.store.observe(installation, 1, observedZones(configuration()), at(24));
  expect(f.versions().map((v) => rectangleMembership({ xMin: 1000, yMin: 1000, xMax: 2000, yMax: 2000 }, v.polygon))).toEqual(['WITHIN', 'WITHIN', 'WITHIN', 'WITHIN']);
  expect(triggeringMatch(square(), f.versions(), at(12))).toMatchObject({ status: 'CONFIRMED_GEOMETRY_MATCH', zoneVersionId: f.versions()[0]!.id });
  const duplicate = { ...f.versions()[0]!, id: 'another', slot: 1 };
  expect(triggeringMatch(square(), [...f.versions(), duplicate], at(12))).toMatchObject({ status: 'AMBIGUOUS', zoneVersionId: null });
  expect(triggeringMatch(null, f.versions(), at(12)).status).toBe('UNKNOWN');
});
it('historical matching excludes pre-discovery, change gaps and newly observed repurposed geometry', async () => {
  const f = zoneDatabase(), config = configuration();
  await f.store.observe(installation, 1, observedZones(config), at(0));
  await f.store.observe(installation, 1, observedZones(config), at(24));
  config.Areas.PolygonInfoList[0]!.PointList = square(800, 8000);
  await f.store.observe(installation, 1, observedZones(config), at(48));
  await f.store.observe(installation, 1, observedZones(config), at(72));
  expect(triggeringMatch(square(), f.versions(), at(-1)).status).toBe('UNKNOWN');
  expect(triggeringMatch(square(), f.versions(), at(36)).status).toBe('UNKNOWN');
  expect(triggeringMatch(square(800, 8000), f.versions(), at(12)).status).toBe('UNKNOWN');
  expect(triggeringMatch(square(800, 8000), f.versions(), at(60)).status).toBe('CONFIRMED_GEOMETRY_MATCH');
});
it('supports intersecting, contained, enclosing, disjoint and touching rectangles without a spatial library', () => {
  const polygon = square(1000, 8000);
  expect(rectangleMembership({ xMin: 2000, yMin: 2000, xMax: 4000, yMax: 4000 }, polygon)).toBe('WITHIN');
  expect(rectangleMembership({ xMin: 0, yMin: 2000, xMax: 2000, yMax: 4000 }, polygon)).toBe('INTERSECTS');
  expect(rectangleMembership({ xMin: 0, yMin: 0, xMax: 9000, yMax: 9000 }, polygon)).toBe('INTERSECTS');
  expect(rectangleMembership({ xMin: 9000, yMin: 9000, xMax: 10000, yMax: 10000 }, polygon)).toBe('OUTSIDE');
  expect(rectangleMembership({ xMin: 0, yMin: 2000, xMax: 1000, yMax: 4000 }, polygon)).toBe('INTERSECTS');
  expect(usablePolygon([{ X: 0, Y: 0 }, { X: 9000, Y: 0 }, { X: 2000, Y: 2000 }, { X: 0, Y: 9000 }])).toBe(true);
});
it('migration adds only zone metadata and preserves canonical/source tables', () => {
  const sql = readFileSync('prisma/migrations/20261014090000_uniview_zones/migration.sql', 'utf8');
  expect(sql).not.toMatch(/(?:^|;)\s*(?:DROP|DELETE|TRUNCATE)\b/);
  expect(sql).not.toMatch(/ALTER TABLE "(?:SecurityEvent|UniviewNotification|EventSnapshot|UniviewObject)"/);
  expect(sql).toContain('"slot" BETWEEN 0 AND 3');
  expect(sql).toContain('"ObjectZoneEvidence_confirmed"');
});
it('ignores stale observations and retries a serialization conflict without duplicate versions', async () => {
  const f = zoneDatabase();
  const transaction = vi.spyOn(f.prisma, '$transaction').mockRejectedValueOnce({ code: 'P2034' });
  await f.store.observe(installation, 1, observedZones(configuration()), at(24));
  expect(transaction).toHaveBeenCalledTimes(2);
  const before = structuredClone(f.state());
  const old = configuration(); old.Areas.PolygonInfoList[0]!.PointList = square(1000, 7000);
  await f.store.observe(installation, 1, observedZones(old), at(0));
  expect(f.state()).toEqual(before);
  await expect(f.store.rename(installation, 1, 0, 'Invalid backdated name', at(0))).rejects.toThrow('Stale zone rename');
});

it('accepts firmware disabled three-zero placeholders without fabricating polygon geometry', async () => {
  const raw = configuration(), slot = raw.Areas.PolygonInfoList[3]!;
  slot.PointNum = 3; slot.PointList = [{X:0,Y:0},{X:0,Y:0},{X:0,Y:0}];
  const f = zoneDatabase(); await f.store.observe(installation,1,observedZones(raw),at(0));
  expect(f.versions()).toHaveLength(4); expect(f.versions()[3]).toMatchObject({enabled:false,polygon:[]});
  slot.Enabled = 1; expect(()=>observedZones(raw)).toThrow();
  slot.Enabled = 0; slot.PointList[0]!.X = 1; expect(()=>observedZones(raw)).toThrow();
});
