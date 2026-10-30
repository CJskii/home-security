import { expect, it, vi } from 'vitest';
import { createZoneEnricher, type ZoneEnrichmentStore, type ZoneEvidenceWrite, type ZoneObject } from '../src/uniview/zone-enrichment.js';
import type { SmartSearchEntry } from '../src/uniview/client-schemas.js';
import { observedZones, type ZoneVersion } from '../src/uniview/zones.js';
import { createZoneEnrichmentStore } from '../src/uniview/zone-store.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { at, configuration, eventId, installation, square, zoneDatabase } from './zone-fixtures.js';
function object(id = 'object'): ZoneObject {
  return { id, category: 'PERSON', sourceTimestamp: at(12), coordinateStatus: 'VALID', xMin: 2000, yMin: 3000, xMax: 4000, yMax: 8000,
    fullFrameSnapshot: { id: 'scene', origin: 'NVR_PUSH', status: 'RECEIVED', imageType: '1', referenceStatus: 'VERIFIED', nvrPictureName: 'scene-name', nvrPictureSize: 100, sha256: 'a'.repeat(64) },
    cropSnapshot: { id: 'crop', origin: 'NVR_PUSH', status: 'RECEIVED', imageType: '2', referenceStatus: 'VERIFIED', nvrPictureName: 'crop-name', nvrPictureSize: 50, sha256: 'b'.repeat(64) }, zoneEvidence: null };
}
function entry(): SmartSearchEntry {
  return { RecordID: 'record', Type: 2, ChannelID: 1, Time: at(12).getTime() / 1000, FullPicture: { Name: 'scene-name', Size: 100 },
    ObjectList: [{ ObjectID: 999, ObjectPicture: { Name: 'crop-name', Size: 50 }, ObjectInfo: { ObjectType: 2,
      PersonInfo: { PersonID: 700, Position: '2000,3000;4000,8000', RuleInfo: { RuleType: 1, PointNum: 4, PointList: square(), TrigerType: 0 } } } }] };
}
async function setup() {
  const f = zoneDatabase(); await f.store.observe(installation, 1, observedZones(configuration()), at(0));
  await f.store.observe(installation, 1, observedZones(configuration()), at(24));
  let versions = f.versions(); const objects = [object()]; const writes: ZoneEvidenceWrite[] = [];
  const event = { id: eventId, sourceInstallationId: installation, nvrChannel: 1, alarmType: 'EnterArea', objects };
  const store: ZoneEnrichmentStore = { load: vi.fn(async () => event), versions: vi.fn(async () => versions), save: vi.fn(async (_installation, _event, write) => {
    const target = objects.find((o) => o.id === write.objectId)!;
    if (target.zoneEvidence && (target.zoneEvidence.status !== 'UNKNOWN' || target.zoneEvidence.status === write.status && JSON.stringify(target.zoneEvidence.sourceRules) === JSON.stringify(write.sourceRules))) return false;
    writes.push(write); target.zoneEvidence = { ...write }; return true;
  }) };
  const searchObjects = vi.fn(async () => [entry()]);
  const service = createZoneEnricher(store, { searchObjects }, installation, () => at(48));
  return { f, objects, event, store, searchObjects, service, writes, setVersions: (v: ZoneVersion[]) => { versions = v; } };
}
it('persists original Smart Search rule and evidence-based trigger separately from overlapping memberships', async () => {
  const f = await setup(); const result = await f.service.enrichEvent(eventId);
  expect(result[0]).toMatchObject({ status: 'CONFIRMED_GEOMETRY_MATCH', persisted: true });
  const write = f.writes[0]!;
  expect(write.zoneVersionId).toBe(f.f.versions()[0]!.id);
  expect(write.memberships.filter((m) => m.relationship === 'WITHIN')).toHaveLength(4);
  expect(write.sourceRules[0]).toMatchObject({ smartObjectId: '999', recordId: 'record', rule: { TrigerType: 0, PointList: square() }, imageMatch: 'VERIFIED_CROP_REFERENCE' });
  expect(write.provenance).toMatchObject({ fullFrameSha256: 'a'.repeat(64), membershipBasis: 'original_full_frame_rectangle' });
});
it('idempotent enrichment reuses stored evidence without NVR calls, and later sync/renaming cannot rewrite it', async () => {
  const f = await setup(); await f.service.enrichEvent(eventId);
  const original = structuredClone(f.writes[0]);
  await f.f.store.rename(installation, 1, 0, 'New purpose', at(30));
  await f.f.store.observe(installation, 1, observedZones(configuration()), at(48)); f.setVersions(f.f.versions());
  expect((await f.service.enrichEvent(eventId))[0]!.persisted).toBe(false);
  expect(f.writes).toHaveLength(1); expect(f.writes[0]).toEqual(original); expect(f.searchObjects).toHaveBeenCalledOnce();
});
it('retains unmatched source polygons when no historically appropriate configuration exists', async () => {
  const f = await setup();
  f.setVersions(f.f.versions().map((v) => ({ ...v, observedAt: at(24), lastObservedAt: at(48) })));
  expect((await f.service.enrichEvent(eventId))[0]).toMatchObject({ status: 'UNKNOWN', reason: 'no_observed_configuration_match', persisted: true });
  expect(f.writes[0]!.sourceRules[0]).toMatchObject({ rule: { PointList: square() } }); expect(f.writes[0]!.memberships).toEqual([]);
});
it('marks ambiguous configured polygons without choosing a convenient slot', async () => {
  const f = await setup(); const duplicate = { ...f.f.versions()[0]!, id: 'duplicate-slot', slot: 1 };
  f.setVersions([...f.f.versions(), duplicate]);
  expect((await f.service.enrichEvent(eventId))[0]!.status).toBe('AMBIGUOUS'); expect(f.writes[0]!.zoneVersionId).toBeNull();
});
it('preserves missing/invalid rule evidence without fabricating a source polygon', async () => {
  const f = await setup(); const candidate = entry(); delete candidate.ObjectList[0]!.ObjectInfo.PersonInfo!.RuleInfo;
  f.searchObjects.mockResolvedValue([candidate]);
  expect((await f.service.enrichEvent(eventId))[0]).toMatchObject({ status: 'UNKNOWN', reason: 'missing_or_invalid_rule', persisted: true });
  expect(f.writes[0]!.sourceRules[0]!.rule).toBeNull(); expect(f.writes[0]!.memberships).toHaveLength(4);
});
it('requires verified image association, never just nearby timestamps or numeric source IDs', async () => {
  const f = await setup(); f.objects[0]!.fullFrameSnapshot!.referenceStatus = 'UNRESOLVED'; f.objects[0]!.cropSnapshot!.referenceStatus = 'UNRESOLVED';
  expect((await f.service.enrichEvent(eventId))[0]!.status).toBe('UNKNOWN'); expect(f.searchObjects).not.toHaveBeenCalled();
  expect(f.writes[0]!.memberships).toHaveLength(4); // Pure geometry remains useful, not triggering evidence.
  f.objects[0]!.fullFrameSnapshot!.referenceStatus = 'VERIFIED'; f.objects[0]!.cropSnapshot!.referenceStatus = 'VERIFIED';
  expect((await f.service.enrichEvent(eventId))[0]!.status).toBe('CONFIRMED_GEOMETRY_MATCH');
  expect(f.writes).toHaveLength(2);
});
it('accepts exact verified scene + category + rectangle when crop evidence is absent', async () => {
  const f = await setup(); f.objects[0]!.cropSnapshot = null;
  expect((await f.service.enrichEvent(eventId))[0]!.status).toBe('CONFIRMED_GEOMETRY_MATCH');
  expect(f.writes[0]!.sourceRules[0]!.imageMatch).toBe('VERIFIED_SCENE_RECTANGLE');
});
it('rejects a conflicting scene even when a crop Name matches', async () => {
  const f = await setup(); const candidate = entry(); candidate.FullPicture.Name = 'another-scene'; f.searchObjects.mockResolvedValue([candidate]);
  expect((await f.service.enrichEvent(eventId))[0]!.status).toBe('UNKNOWN'); expect(f.writes[0]!.sourceRules).toEqual([]);
});
it('does not apply original boxes to later live frames, crops, or unlinked scenes', async () => {
  const f = await setup(); f.objects[0]!.fullFrameSnapshot = null;
  expect((await f.service.enrichEvent(eventId))[0]!.status).toBe('CONFIRMED_GEOMETRY_MATCH');
  expect(f.writes[0]!.memberships).toEqual([]);
});
it('distinguishes ambiguous Smart Search objects and does not merge canonical identities', async () => {
  const f = await setup(); const candidate = entry(); candidate.ObjectList.push({ ...candidate.ObjectList[0]!, ObjectID: 1000 }); f.searchObjects.mockResolvedValue([candidate]);
  expect((await f.service.enrichEvent(eventId))[0]).toMatchObject({ status: 'AMBIGUOUS', reason: 'multiple_source_objects' });
  expect(f.writes[0]!.sourceRules).toHaveLength(2); expect(f.objects).toHaveLength(1);
});
it('retries after NVR failure without freezing unavailable evidence as UNKNOWN', async () => {
  const f = await setup(); f.searchObjects.mockRejectedValueOnce(new Error('private auth failure'));
  await expect(f.service.enrichEvent(eventId)).rejects.toMatchObject({ code: 'nvr_unavailable' }); expect(f.writes).toHaveLength(0);
  expect((await f.service.enrichEvent(eventId))[0]!.status).toBe('CONFIRMED_GEOMETRY_MATCH');
});
it('filters wrong camera, time, alarm profile and object class results', async () => {
  const f = await setup(); const wrongChannel = entry(); wrongChannel.ChannelID = 2;
  const wrongTime = entry(); wrongTime.Time += 20;
  const wrongType = entry(); wrongType.Type = 8;
  const wrongClass = entry(); wrongClass.ObjectList[0]!.ObjectInfo.ObjectType = 4;
  f.searchObjects.mockResolvedValue([wrongChannel, wrongTime, wrongType, wrongClass]);
  expect((await f.service.enrichEvent(eventId))[0]!.status).toBe('UNKNOWN'); expect(f.writes[0]!.sourceRules).toEqual([]);
});
it('bounds selected-event work, fences installation identity and prevents overlapping enrichment', async () => {
  const f = await setup(); f.event.sourceInstallationId = eventId;
  await expect(f.service.enrichEvent(eventId)).rejects.toMatchObject({ code: 'installation_mismatch' });
  f.event.sourceInstallationId = installation;
  let release!: (value: SmartSearchEntry[]) => void;
  f.searchObjects.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  const pending = f.service.enrichEvent(eventId); await vi.waitFor(() => expect(f.searchObjects).toHaveBeenCalledOnce());
  await expect(f.service.enrichEvent(eventId)).rejects.toMatchObject({ code: 'busy' });
  release([entry()]); await pending;
  f.objects.push(...Array.from({ length: 64 }, (_, i) => object(`extra-${i}`)));
  await expect(f.service.enrichEvent(eventId)).rejects.toMatchObject({ code: 'limit' });
});
it('Prisma persistence fences ownership and never overwrites resolved evidence', async () => {
  const objectRow = { zoneEvidence: null as { status: string; sourceRules: unknown[] } | null, event: { nvrChannel: 1 } };
  const tx = { univiewObject: { findFirst: vi.fn(async () => objectRow) }, univiewZoneVersion: { findMany: vi.fn(async () => [{ id: 'zone-version' }]) },
    objectZoneEvidence: { create: vi.fn(async () => { objectRow.zoneEvidence = { status: 'CONFIRMED_GEOMETRY_MATCH', sourceRules: [{}] }; }) },
    objectZoneMembership: { createMany: vi.fn(async () => ({ count: 1 })) } };
  const prisma = { $transaction: async (work: (value: unknown) => Promise<unknown>) => work(tx) } as unknown as PrismaClient;
  const f = await setup(); await f.service.enrichEvent(eventId); const write = { ...f.writes[0]!, zoneVersionId: 'zone-version', memberships: [{ zoneVersionId: 'zone-version', relationship: 'WITHIN' as const }] };
  const store = createZoneEnrichmentStore(prisma);
  expect(await store.save(installation, eventId, write)).toBe(true); expect(await store.save(installation, eventId, write)).toBe(false);
  expect(tx.objectZoneEvidence.create).toHaveBeenCalledOnce();
  expect(tx.univiewObject.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: write.objectId, eventId, event: { sourceInstallationId: installation } } }));
  expect(tx.univiewZoneVersion.findMany).toHaveBeenCalledWith({ where: { id: { in: ['zone-version'] }, zone: { sourceInstallationId: installation, channel: 1 } } });
});

it('later unchanged observation can corroborate UNKNOWN using retained source rules without a new NVR search', async () => {
  const f = await setup();
  f.setVersions(f.f.versions().map((v) => ({ ...v, lastObservedAt: at(0) })));
  expect((await f.service.enrichEvent(eventId))[0]!.status).toBe('UNKNOWN');
  const originalRules = structuredClone(f.writes[0]!.sourceRules);
  f.setVersions(f.f.versions());
  expect((await f.service.enrichEvent(eventId))[0]!.status).toBe('CONFIRMED_GEOMETRY_MATCH');
  expect(f.writes[1]!.sourceRules).toEqual(originalRules);
  expect(f.searchObjects).toHaveBeenCalledOnce();
  expect((await f.service.enrichEvent(eventId))[0]!.persisted).toBe(false);
});
it('Prisma store upgrades UNKNOWN while preserving source evidence and rejects foreign versions', async () => {
  const f = await setup(); await f.service.enrichEvent(eventId); const write = f.writes[0]!;
  const existing = { status: 'UNKNOWN', sourceRules: write.sourceRules };
  const tx = { univiewObject: { findFirst: vi.fn(async () => ({ zoneEvidence: existing, event: { nvrChannel: 1 } })) },
    univiewZoneVersion: { findMany: vi.fn(async () => f.f.versions()) },
    objectZoneEvidence: { update: vi.fn(async () => {}) }, objectZoneMembership: { createMany: vi.fn(async () => ({ count: 0 })) } };
  const prisma = { $transaction: async (work: (value: unknown) => Promise<unknown>) => work(tx) } as unknown as PrismaClient;
  const store = createZoneEnrichmentStore(prisma);
  expect(await store.save(installation, eventId, write)).toBe(true);
  expect(tx.objectZoneEvidence.update).toHaveBeenCalledOnce();
  tx.univiewZoneVersion.findMany.mockResolvedValueOnce([]);
  await expect(store.save(installation, eventId, write)).rejects.toThrow('Invalid zone ownership');
  await expect(store.save(installation, eventId, { ...write, sourceRules: [{ rule: { PointNum: 0 } }] })).rejects.toThrow('Source rule evidence is immutable');
});
