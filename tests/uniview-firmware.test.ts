import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { normalizeNotification } from '../src/uniview/schemas.js';
import { ingestNotification } from '../src/uniview/ingest.js';
import { config, fixtureStore, jpeg } from './uniview-fixtures.js';
const alarm = JSON.parse(readFileSync(new URL('./fixtures/uniview-alarm-firmware.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const structure = JSON.parse(readFileSync(new URL('./fixtures/uniview-structure-firmware.json', import.meta.url), 'utf8')) as Record<string, unknown>;
it('real firmware ObjInfo supplies counts; Alarm ObjectID and Structure PersonID stay separate', () => {
  const a = normalizeNotification(alarm, 'ALARM'), s = normalizeNotification(structure, 'STRUCTURE');
  expect(a).toMatchObject({ nvrChannel: 1, alarmType: 'EnterArea', objectType: '2', personCount: null });
  expect(a.metadata).toMatchObject({ RelatedObjects: { ObjectNum: 1, ObjectList: [{ ObjectID: 21001, ObjectType: 2 }] } });
  expect(s).toMatchObject({ personCount: 1, vehicleCount: 0 });
  expect(s.metadata).toMatchObject({ StructureInfo: { ObjInfo: { PersonInfoList: [{ PersonID: 31001, Position: '1200,800;2600,3400', SmallPicAttachIndex: 2, LargePicAttachIndex: 1, RuleInfo: { RuleType: 3, PointNum: 0 }, AttributeInfo: { Gender: 98 } }] } } });
  expect(JSON.stringify(s.metadata)).not.toContain('"Data"');
});
it('real image Type/CaptureTime become descriptors, using synthetic RAM JPEGs only', async () => {
  const crop = Buffer.from(jpeg); crop.writeUInt16BE(352, 7); crop.writeUInt16BE(224, 9);
  const input = structuredClone(structure) as { StructureInfo: { ImageInfoList: Record<string, unknown>[] } };
  input.StructureInfo.ImageInfoList[0]!.Data = jpeg.toString('base64');
  input.StructureInfo.ImageInfoList[1]!.Data = crop.toString('base64');
  const f = fixtureStore(); const a = await ingestNotification(config, f.store, alarm, 'ALARM');
  const s = await ingestNotification(config, f.store, input, 'STRUCTURE');
  expect(s.eventId).toBe(a.eventId); expect(f.state().events).toHaveLength(1);
  expect(f.state().snapshots).toEqual(expect.arrayContaining([
    expect.objectContaining({ sourceImageIndex: 1, imageType: '1', capturedAt: new Date(1700000000000), width: 3840, height: 2160 }),
    expect.objectContaining({ sourceImageIndex: 2, imageType: '2', capturedAt: new Date(1700000000000), declaredWidth: 205, declaredHeight: 342, width: 224, height: 352 }),
  ]));
  expect(f.state().notifications[1]).toMatchObject({ personCount: 1, vehicleCount: 0, metadata: { StructureInfo: { ImageInfoList: [expect.objectContaining({ Size: 762712 }), expect.objectContaining({ Size: 52564 })] } } });
  expect(JSON.stringify(f.state())).not.toContain(jpeg.toString('base64'));
});
it('missing source capture time/counts remain unknown rather than derived from notification time', () => {
  const raw = structuredClone(structure) as { StructureInfo: { ObjInfo: Record<string, unknown>; ImageInfoList: Record<string, unknown>[] } };
  delete raw.StructureInfo.ObjInfo.PersonNum; delete raw.StructureInfo.ImageInfoList[0]!.CaptureTime;
  const n = normalizeNotification(raw, 'STRUCTURE'); expect(n.personCount).toBeNull(); expect(n.images[0]!.CaptureTime).toBeUndefined();
});
it('channel-2 optional and unknown metadata differences preserve ingestion without invented projections', async () => {
  const a = structuredClone(alarm) as { AlarmInfo: { AlarmSrcID: number; RelatedID: string } };
  const s = structuredClone(structure) as { SrcID: number; RelatedID: string; StructureInfo: Record<string, unknown> };
  a.AlarmInfo.AlarmSrcID = 2; s.SrcID = 2;
  s.StructureInfo.ObjInfo = { VehicleInfoList: [{ VehicleID: 'camera-2-object', Position: '10,20;30,40', UnknownFirmwareCode: 255 }] };
  s.StructureInfo.ImageInfoList = [{ Index: 1, Width: 3840, Height: 2160, Data: 'invalid-image', AlternateTimestamp: 1700000000 }];
  const f = fixtureStore(); const first = await ingestNotification(config, f.store, s, 'STRUCTURE');
  const second = await ingestNotification(config, f.store, a, 'ALARM');
  expect(first.eventId).toBe(second.eventId); expect(f.state().events).toHaveLength(1);
  expect(f.state().events[0]).toMatchObject({ nvrChannel: 2, camera: 'camera_2', nativeEndedAt: null });
  expect(f.state().notifications[0]).toMatchObject({ personCount: null, vehicleCount: null,
    metadata: { StructureInfo: { ObjInfo: { VehicleInfoList: [{ VehicleID: 'camera-2-object', Position: '10,20;30,40', UnknownFirmwareCode: 255 }] } } } });
  expect(f.state().snapshots[0]).toMatchObject({ status: 'FAILED', capturedAt: null, imageType: null });
});
