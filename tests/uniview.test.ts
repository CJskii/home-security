import { expect, it, vi } from 'vitest';
import { config, jpeg, alarm, structure, fixtureStore } from './uniview-fixtures.js';
import { ingestNotification } from '../src/uniview/ingest.js';
import { parseNotificationJson, normalizeNotification } from '../src/uniview/schemas.js';
it.each([true, false])('Alarm/Structure correlate in either order without native ends (%s)', async (first) => {
  const f = fixtureStore();
  const incoming = first ? [['ALARM', alarm()], ['STRUCTURE', structure()]] as const : [['STRUCTURE', structure()], ['ALARM', alarm()]] as const;
  const ids = [];
  for (const [kind, raw] of incoming) ids.push((await ingestNotification(config, f.store, raw, kind)).eventId);
  expect(new Set(ids).size).toBe(1); expect(f.state().events).toHaveLength(1);
  expect(f.state().events[0]).toMatchObject({ alarmSeen: true, occurredAt: new Date(1000000), nativeEndedAt: null });
  expect(f.state().notifications).toHaveLength(2);
});
it('concurrent repeats retain one UUID, one notification and metadata only', async () => {
  const f = fixtureStore();
  const results = await Promise.all(Array.from({ length: 8 }, () => ingestNotification(config, f.store, structure(), 'STRUCTURE')));
  expect(new Set(results.map((r) => r.eventId)).size).toBe(1); expect(results.filter((r) => r.newNotification)).toHaveLength(1);
  expect(f.state().snapshots).toHaveLength(1);
  expect(f.state().snapshots[0]).toMatchObject({ width: 3840, height: 2160, bytes: jpeg.length, origin: 'NVR_PUSH', capturedAt: null });
  expect(JSON.stringify(f.state())).not.toContain(jpeg.toString('base64')); expect(JSON.stringify(f.state())).not.toContain('"Data"');
  expect(f.calls[0]).toMatchObject({ options: { isolationLevel: 'Serializable' } });
});
it('source descriptors and unrecognised structured fields survive without media', async () => {
  const f = fixtureStore(), payload = structure();
  const raw = { ...payload, FirmwareSpecific: { RuleID: 7 }, StructureInfo: { ...payload.StructureInfo, ObjectDetails: [{ ID: 4, Position: { Left: 3, Top: 9 } }], ImageInfoList: [{ ...payload.StructureInfo.ImageInfoList[0], Type: 2, Index: 1, CaptureTime: 1002 }] } };
  await ingestNotification(config, f.store, raw, 'STRUCTURE');
  expect(f.state().notifications[0]).toMatchObject({ personCount: 1, vehicleCount: 0, metadata: { FirmwareSpecific: { RuleID: 7 }, StructureInfo: { ObjInfo: { PersonInfoList: [{ PersonID: 12, Position: '7447,825;7981,2410' }] }, ObjectDetails: [{ ID: 4 }] } } });
  expect(f.state().snapshots[0]).toMatchObject({ imageType: '2', capturedAt: new Date(1002000) });
});
it('different identity components remain distinct and unknown counts stay null', async () => {
  const f = fixtureStore();
  const a = await ingestNotification(config, f.store, alarm(12, '01'), 'ALARM');
  expect((await ingestNotification(config, f.store, alarm('12', 1), 'ALARM')).eventId).toBe(a.eventId);
  await ingestNotification(config, f.store, alarm('other'), 'ALARM');
  await ingestNotification(config, f.store, alarm(12, 2), 'ALARM');
  await ingestNotification({ ...config, UNIVIEW_INSTALLATION_ID: '27b01e57-cc3d-4db5-9bdd-f7d89e8149bb' }, f.store, alarm(12), 'ALARM');
  expect(f.state().events).toHaveLength(4); expect(f.state().notifications[0]).toMatchObject({ personCount: null, vehicleCount: null });
});
it('image failure preserves ingestion; DB failures propagate and only conflicts retry', async () => {
  const f = fixtureStore(); await ingestNotification(config, f.store, structure('bad', 'not-base64'), 'STRUCTURE');
  expect(f.state().snapshots[0]).toMatchObject({ status: 'FAILED', failureCode: 'invalid_image' });
  const commit = vi.fn(f.store.commit).mockRejectedValueOnce(new Error('offline'));
  await expect(ingestNotification(config, { commit }, structure(), 'STRUCTURE')).rejects.toThrow(); expect(commit).toHaveBeenCalledOnce();
  commit.mockRejectedValueOnce({ code: 'P2034' }); await ingestNotification(config, { commit }, structure(), 'STRUCTURE'); expect(commit).toHaveBeenCalledTimes(3);
});
it('bounded JSON and metadata reject malformed/unbounded inputs', () => {
  for (const s of ['{"a":1,"\\u0061":2}', '{"x":1e999}', '['.repeat(34) + '0' + ']'.repeat(34), '{"x":1,}', 'true false']) expect(() => parseNotificationJson(Buffer.from(s))).toThrow();
  expect(() => parseNotificationJson(Buffer.from([0xff]))).toThrow();
  expect(normalizeNotification(alarm(), 'ALARM')).toMatchObject({ nvrChannel: 1 });
});
