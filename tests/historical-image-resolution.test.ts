import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createHistoricalImageResolver, RESOLUTION_LIMITS, type HistoricalImageStore, type ResolutionEvent, type ResolutionSnapshot } from '../src/uniview/historical-image-resolution.js';
import { UniviewClientError, type HistoricalPictureReference, type SmartSearchEntry, type SmartSearchQuery } from '../src/uniview/snapshot-client.js';
import { jpeg } from './uniview-fixtures.js';

const eventId = '17b01e57-cc3d-4db5-9bdd-f7d89e8149bb';
const installation = '27b01e57-cc3d-4db5-9bdd-f7d89e8149bb';
const sourceTime = new Date(1700000000000), checkedAt = new Date(1700000060000);
const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
function image(n: number) { const bytes = Buffer.from(jpeg); bytes[26] = n; return bytes; }
function setup(types = [2]) {
  const pictures = new Map([['full', image(10)], ...types.map((_, i): [string, Buffer] => [`crop${i}`, image(20 + i)])]);
  const snapshot = (id: string, imageType: string, index: number, name: string): ResolutionSnapshot => ({
    id, eventId, notificationId: 'notification', origin: 'NVR_PUSH', status: 'RECEIVED', imageType,
    sha256: hash(pictures.get(name)!), sourceImageIndex: index, capturedAt: sourceTime,
    nvrPictureName: null, nvrPictureSize: null, nvrPictureType: null, nvrRecordId: null, referenceVersion: 0, referenceResolvedAt: null,
  });
  const ObjInfo: Record<string, unknown> = {};
  for (const [i, type] of types.entries()) {
    const key = type === 2 ? 'PersonInfoList' : 'VehicleInfoList';
    ObjInfo[key] = [{ PersonID: 9999, ID: 8888, Position: '100,200;300,400', LargePicAttachIndex: 1, SmallPicAttachIndex: i + 2 }];
  }
  const event: ResolutionEvent = { id: eventId, sourceInstallationId: installation, nvrChannel: 1, alarmType: 'EnterArea',
    notifications: [{ id: 'notification', eventId, reportedAt: sourceTime, metadata: { StructureInfo: { ObjInfo } } }],
    snapshots: [snapshot('full-snapshot', '1', 1, 'full'), ...types.map((_, i) => snapshot(`crop-snapshot-${i}`, '2', i + 2, `crop${i}`))] };
  const entries = types.map((type, i): SmartSearchEntry => ({ RecordID: `record${i}`, Type: 2, Time: sourceTime.getTime() / 1000, ChannelID: 1,
    FullPicture: { Name: 'full', Size: 100, Data: jpeg.toString('base64'), URL: 'http://invalid/never-follow' },
    ObjectList: [{ ObjectID: i, ObjectPicture: { Name: `crop${i}`, Size: 200, Data: jpeg.toString('base64') },
      ObjectInfo: { ObjectType: type, ...(type === 2 ? { PersonInfo: { PersonID: 0, Position: '100,200;300,400' } } : { VehicleInfo: { Position: '100,200;300,400', VehicleAttributeInfo: { Type: 998 } } }) } }],
  }));
  const load = vi.fn(async () => structuredClone(event));
  const save = vi.fn<HistoricalImageStore['save']>(async (_installation, original, update) => {
    const target = event.snapshots.find((s) => s.id === original.id)!;
    if (target.referenceVersion !== original.referenceVersion) return false;
    if (update.reference) Object.assign(target, { nvrPictureName: update.reference.picture.Name, nvrPictureSize: update.reference.picture.Size,
      nvrPictureType: update.reference.picture.Type, nvrRecordId: update.reference.recordId, referenceResolvedAt: update.checkedAt });
    target.referenceVersion++;
    return true;
  });
  const store = { load, save };
  const searchObjects = vi.fn(async (q: SmartSearchQuery) => entries.filter((e) => q.ObjectType === undefined || e.ObjectList.some((o) => o.ObjectInfo.ObjectType === q.ObjectType)));
  const historicalPicture = vi.fn<(ref: HistoricalPictureReference, signal?: AbortSignal) => Promise<Buffer>>(async (ref) => Buffer.concat([pictures.get(ref.Name)!, Buffer.from([0, 0, 255, 217])]));
  const client = { searchObjects, historicalPicture };
  const resolver = createHistoricalImageResolver(store, client, installation, () => checkedAt);
  return { event, entries, pictures, client, store, resolver };
}
const statuses = (report: Awaited<ReturnType<ReturnType<typeof createHistoricalImageResolver>['resolveEvent']>>) => report.snapshots.map((s) => s.status);

it('verifies mixed person/vehicle crops independently, sharing scene/download/search metadata without persisting media', async () => {
  const f = setup([2, 4]); const original = structuredClone(f.event);
  expect(statuses(await f.resolver.resolveEvent(eventId))).toEqual(['VERIFIED', 'VERIFIED', 'VERIFIED']);
  expect(f.client.searchObjects).toHaveBeenCalledTimes(2);
  expect(f.client.searchObjects.mock.calls.map(([q]) => q.ObjectType).sort()).toEqual([2, 4]);
  expect(f.client.searchObjects.mock.calls[0]![0]).toEqual({ ChannelID: 1, Begin: 1699999998, End: 1700000002, AlarmType: 'EnterArea', ObjectType: 2 });
  expect(f.client.historicalPicture).toHaveBeenCalledTimes(3);
  for (const [scope, snapshot, update] of f.store.save.mock.calls) {
    expect(scope).toBe(installation); expect(snapshot.eventId).toBe(eventId); expect(snapshot.notificationId).toBe('notification');
    expect(update.reference!.provenance.originalSha256).toBe(snapshot.sha256);
    expect(update.reference!.provenance.method).toBe('smart_object_search_sha256');
    if (snapshot.imageType === '2') expect(update.reference!.provenance.sceneSha256).toBe(original.snapshots[0]!.sha256);
    expect(JSON.stringify(update)).not.toMatch(/Data|\/9j\/|password|invalid\/never-follow/);
  }
  expect(f.event.notifications).toEqual(original.notifications);
  expect(f.event.snapshots.map((s) => [s.id, s.eventId, s.notificationId, s.sha256, s.imageType, s.capturedAt])).toEqual(original.snapshots.map((s) => [s.id, s.eventId, s.notificationId, s.sha256, s.imageType, s.capturedAt]));
});

it('reuses stored references on subsequent calls without Smart Search and re-verifies original bytes', async () => {
  const f = setup(); await f.resolver.resolveEvent(eventId); f.client.searchObjects.mockClear(); f.client.historicalPicture.mockClear();
  const report = await f.resolver.resolveEvent(eventId);
  expect(statuses(report)).toEqual(['VERIFIED', 'VERIFIED']);
  expect(report.searches).toBe(0);
  expect(f.client.searchObjects).not.toHaveBeenCalled(); expect(f.client.historicalPicture).toHaveBeenCalledTimes(2);
  expect(f.store.save.mock.calls.slice(-2).every(([, , u]) => u.reference === undefined)).toBe(true);
});

it('accepts an absent search RecordID without inventing an identifier', async () => {
  const f = setup(); delete f.entries[0]!.RecordID;
  expect(statuses(await f.resolver.resolveEvent(eventId))).toEqual(['VERIFIED', 'VERIFIED']);
  expect(f.store.save.mock.calls.every(([, , u]) => u.reference!.recordId === null)).toBe(true);
});

it('supports separate person/vehicle Structure notifications sharing a scene without matching source IDs', async () => {
  const f = setup([2, 4]);
  const metadata = f.event.notifications[0]!.metadata as { StructureInfo: { ObjInfo: Record<string, unknown> } };
  const vehicle = metadata.StructureInfo.ObjInfo.VehicleInfoList; delete metadata.StructureInfo.ObjInfo.VehicleInfoList;
  f.event.notifications.push({ id: 'vehicle-notification', eventId, reportedAt: sourceTime, metadata: { StructureInfo: { ObjInfo: { VehicleInfoList: vehicle } } } });
  f.event.snapshots[2]!.notificationId = 'vehicle-notification';
  f.event.snapshots.push({ ...f.event.snapshots[0]!, id: 'second-full', notificationId: 'vehicle-notification' });
  expect(statuses(await f.resolver.resolveEvent(eventId))).toEqual(['VERIFIED', 'VERIFIED', 'VERIFIED', 'VERIFIED']);
  expect(f.client.historicalPicture).toHaveBeenCalledTimes(3);
  expect(f.store.save.mock.calls.find(([, s]) => s.id === 'crop-snapshot-1')![1].notificationId).toBe('vehicle-notification');
});

it('rejects a matching crop from a mismatched full scene in the same notification', async () => {
  const f = setup(); f.entries[0]!.FullPicture.Name = 'wrong-scene'; f.pictures.set('wrong-scene', image(77));
  expect(statuses(await f.resolver.resolveEvent(eventId))).toEqual(['INTEGRITY_MISMATCH', 'INTEGRITY_MISMATCH']);
  expect(f.store.save.mock.calls.every(([, , update]) => update.reference === undefined)).toBe(true);
});

it('checks all bounded candidates rather than assigning the first result by time or ID', async () => {
  const f = setup();
  f.pictures.set('wrong', image(44));
  const wrong = structuredClone(f.entries[0]!); wrong.FullPicture.Name = 'wrong'; wrong.ObjectList[0]!.ObjectPicture.Name = 'wrong';
  f.entries.unshift(wrong);
  expect(statuses(await f.resolver.resolveEvent(eventId))).toEqual(['VERIFIED', 'VERIFIED']);
  expect(f.store.save.mock.calls[0]![2].reference!.picture.Name).toBe('full');
});

it('does not accept entries from a different channel, time window or alarm profile even with identical bytes', async () => {
  for (const changes of [{ ChannelID: 2 }, { Time: 1700000030 }, { Type: 1 }]) {
    const f = setup(); Object.assign(f.entries[0]!, changes);
    expect(statuses(await f.resolver.resolveEvent(eventId))).toEqual(['NOT_FOUND', 'NOT_FOUND']);
    expect(f.client.historicalPicture).not.toHaveBeenCalled();
  }
});

it('marks missing original evidence unresolved without fetching or substituting live images', async () => {
  const f = setup(); f.event.snapshots[0]!.sha256 = null; f.event.snapshots[1]!.capturedAt = null; f.event.notifications[0]!.reportedAt = null;
  const report = await f.resolver.resolveEvent(eventId);
  expect(report.snapshots.map((s) => s.reason)).toEqual(['missing_original_hash', 'missing_source_time']);
  expect(f.client.searchObjects).not.toHaveBeenCalled(); expect(f.client.historicalPicture).not.toHaveBeenCalled();
});

it('preserves timestamp uncertainty and uses an unclassified bounded search when no source class is available', async () => {
  const f = setup(); f.event.notifications[0]!.metadata = {};
  f.event.snapshots.forEach((s) => { s.capturedAt = null; });
  expect(statuses(await f.resolver.resolveEvent(eventId))).toEqual(['VERIFIED', 'VERIFIED']);
  expect(f.client.searchObjects).toHaveBeenCalledOnce();
  expect(f.client.searchObjects.mock.calls[0]![0]).not.toHaveProperty('ObjectType');
  expect(f.store.save.mock.calls[0]![2].reference!.provenance.timeBasis).toBe('notification_reported');
  expect(f.event.snapshots.every((s) => s.capturedAt === null)).toBe(true);
});

it('requires a valid crop hash even when its associated full frame matches', async () => {
  const f = setup(); f.pictures.set('crop0', image(99));
  expect(statuses(await f.resolver.resolveEvent(eventId))).toEqual(['VERIFIED', 'INTEGRITY_MISMATCH']);
  expect(f.event.snapshots[1]!.nvrPictureName).toBeNull();
});

it('can verify an original crop by its own exact hash when the historical full frame is explicitly missing', async () => {
  const f = setup();
  f.client.historicalPicture.mockImplementation(async (ref) => {
    if (ref.Type === 1) throw new UniviewClientError('unavailable', undefined, 404);
    return f.pictures.get(ref.Name)!;
  });
  expect(statuses(await f.resolver.resolveEvent(eventId))).toEqual(['NOT_FOUND', 'VERIFIED']);
  expect(f.store.save.mock.calls[1]![2].reference!.provenance.sceneSha256).toBeNull();
  expect(f.store.save.mock.calls[1]![2].reference!.provenance.originalSha256).toBe(f.event.snapshots[1]!.sha256);
});

it('retains last-verified references on temporary failure and avoids unnecessary searches', async () => {
  const f = setup(); await f.resolver.resolveEvent(eventId); const previous = structuredClone(f.event.snapshots);
  f.client.searchObjects.mockClear(); f.client.historicalPicture.mockRejectedValue(new UniviewClientError('timeout'));
  expect(statuses(await f.resolver.resolveEvent(eventId))).toEqual(['TEMPORARILY_UNAVAILABLE', 'TEMPORARILY_UNAVAILABLE']);
  expect(f.client.searchObjects).not.toHaveBeenCalled();
  expect(f.event.snapshots.map((s) => [s.nvrPictureName, s.nvrPictureSize, s.referenceResolvedAt])).toEqual(previous.map((s) => [s.nvrPictureName, s.nvrPictureSize, s.referenceResolvedAt]));
});

it('re-resolves missing stored references and verifies replacement references before changing them', async () => {
  const f = setup(); await f.resolver.resolveEvent(eventId);
  f.entries[0]!.FullPicture.Name = 'replacement-full'; f.entries[0]!.ObjectList[0]!.ObjectPicture.Name = 'replacement-crop';
  f.pictures.set('replacement-full', f.pictures.get('full')!); f.pictures.set('replacement-crop', f.pictures.get('crop0')!);
  f.client.historicalPicture.mockImplementation(async (ref) => {
    if (['full', 'crop0'].includes(ref.Name)) throw new UniviewClientError('unavailable', undefined, 404);
    return f.pictures.get(ref.Name)!;
  });
  expect(statuses(await f.resolver.resolveEvent(eventId))).toEqual(['VERIFIED', 'VERIFIED']);
  expect(f.event.snapshots.map((s) => s.nvrPictureName)).toEqual(['replacement-full', 'replacement-crop']);
});

it('treats empty searches and 404/410 as provisional NOT_FOUND, never permanent expiry', async () => {
  const f = setup(); await f.resolver.resolveEvent(eventId); f.client.searchObjects.mockResolvedValue([]);
  f.client.historicalPicture.mockRejectedValue(new UniviewClientError('unavailable', undefined, 410));
  for (let i = 0; i < 2; i++) expect(statuses(await f.resolver.resolveEvent(eventId))).toEqual(['NOT_FOUND', 'NOT_FOUND']);
  expect(f.event.snapshots.every((s) => s.nvrPictureName !== null)).toBe(true);
  expect(f.store.save.mock.calls.slice(-4).every(([, , u]) => u.reason === 'verified_reference_not_found')).toBe(true);
});

it('does not treat HTTP 500, authentication failures or failed search cleanup as image expiry', async () => {
  for (const error of [new UniviewClientError('unavailable', undefined, 500), new UniviewClientError('authentication'), new UniviewClientError('search_cleanup_failed')]) {
    const f = setup(); f.client.searchObjects.mockRejectedValue(error);
    expect(statuses(await f.resolver.resolveEvent(eventId))).toEqual(['TEMPORARILY_UNAVAILABLE', 'TEMPORARILY_UNAVAILABLE']);
  }
});

it('does not claim integrity mismatch when another candidate could not be checked', async () => {
  const f = setup(); const unavailable = structuredClone(f.entries[0]!); unavailable.FullPicture.Name = 'offline';
  f.entries.unshift(unavailable); f.pictures.set('full', image(88));
  f.client.historicalPicture.mockImplementation(async (ref) => { if (ref.Name === 'offline') throw new UniviewClientError('timeout'); return f.pictures.get(ref.Name)!; });
  const report = await f.resolver.resolveEvent(eventId);
  expect(report.snapshots[0]!.status).toBe('TEMPORARILY_UNAVAILABLE');
});

it('dry-run performs source verification but never writes and never leaves images in its report', async () => {
  const f = setup(); const original = structuredClone(f.event);
  const report = await f.resolver.resolveEvent(eventId, { persist: false });
  expect(statuses(report)).toEqual(['VERIFIED', 'VERIFIED']);
  expect(f.store.save).not.toHaveBeenCalled(); expect(f.event).toEqual(original);
  expect(JSON.stringify(report)).not.toMatch(/Name|Size|Data|Buffer|\/9j\//);
});

it('reports optimistic concurrency conflicts without overwriting a newer resolution', async () => {
  const f = setup(); f.store.save.mockResolvedValue(false);
  const report = await f.resolver.resolveEvent(eventId);
  expect(report.snapshots.every((s) => s.status === 'UNRESOLVED' && s.reason === 'concurrent_update' && !s.persisted)).toBe(true);
});

it('fences installation identity, invalid UUIDs and oversized event histories before any source calls', async () => {
  const f = setup();
  await expect(f.resolver.resolveEvent('invalid')).rejects.toMatchObject({ code: 'invalid_request' });
  f.event.sourceInstallationId = eventId;
  await expect(f.resolver.resolveEvent(eventId)).rejects.toMatchObject({ code: 'installation_mismatch' });
  f.event.sourceInstallationId = installation;
  f.event.snapshots = Array.from({ length: RESOLUTION_LIMITS.snapshots + 1 }, () => f.event.snapshots[0]!);
  await expect(f.resolver.resolveEvent(eventId)).rejects.toMatchObject({ code: 'event_limit' });
  expect(f.client.searchObjects).not.toHaveBeenCalled(); expect(f.store.save).not.toHaveBeenCalled();
});

it('refuses cross-event snapshot data from a faulty store without writing to another canonical event', async () => {
  const f = setup(); f.event.snapshots[0]!.eventId = installation;
  await expect(f.resolver.resolveEvent(eventId)).rejects.toMatchObject({ code: 'invalid_request' });
  expect(f.store.save).not.toHaveBeenCalled(); expect(f.client.searchObjects).not.toHaveBeenCalled();
});

it('enforces candidate/download bounds and cancellation without an unbounded queue', async () => {
  const f = setup();
  f.entries.splice(0, 1, ...Array.from({ length: RESOLUTION_LIMITS.candidates + 1 }, (_, i) => ({ ...structuredClone(f.entries[0]!), FullPicture: { Name: `different-${i}`, Size: 100 } })));
  expect(statuses(await f.resolver.resolveEvent(eventId))).toEqual(['UNRESOLVED', 'UNRESOLVED']);
  const cancelled = setup(); const controller = new AbortController(); controller.abort();
  expect(statuses(await cancelled.resolver.resolveEvent(eventId, { signal: controller.signal }))).toEqual(['TEMPORARILY_UNAVAILABLE', 'TEMPORARILY_UNAVAILABLE']);
  expect(cancelled.client.searchObjects).not.toHaveBeenCalled();
});

it('rejects concurrent event resolution locally rather than starting another search', async () => {
  const f = setup(); let release!: (entries: SmartSearchEntry[]) => void;
  f.client.searchObjects.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  const running = f.resolver.resolveEvent(eventId);
  await vi.waitFor(() => expect(f.client.searchObjects).toHaveBeenCalledOnce());
  await expect(f.resolver.resolveEvent(eventId)).rejects.toMatchObject({ code: 'busy' });
  release(f.entries); await running;
});
