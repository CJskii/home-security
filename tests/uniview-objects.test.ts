import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { projectObjects, type ObjectImage, type ObjectSource } from '../src/uniview/object-projection.js';
import { projectStoredNotification } from '../src/uniview/store.js';
import { ingestNotification } from '../src/uniview/ingest.js';
import { alarm, config, fixtureStore, jpeg, structure } from './uniview-fixtures.js';

const source = (metadata: unknown): ObjectSource => ({ id: 'notification', eventId: 'event', kind: 'STRUCTURE', reportedAt: new Date(1001000), metadata });
const image = (id: string, sourceImageIndex: number, imageType: string): ObjectImage => ({ id, eventId: 'event', notificationId: 'notification', origin: 'NVR_PUSH', sourceImageIndex, imageType });
it('projects people with exact source identifiers, rectangle, timestamp and separate scene/crop links', () => {
  const [object] = projectObjects(source(structure()), [image('scene', 1, '1'), image('crop', 2, '2')]);
  expect(object).toMatchObject({ category: 'PERSON', sourceCategoryCode: null, sourceIdentifiers: { PersonID: 12 },
    sourceList: 'StructureInfo.ObjInfo.PersonInfoList', sourceOrdinal: 0, positionRaw: '7447,825;7981,2410',
    xMin: 7447, yMin: 825, xMax: 7981, yMax: 2410, coordinateStatus: 'VALID',
    fullFrameSnapshotId: 'scene', cropSnapshotId: 'crop', sourceTimestamp: new Date(1001000) });
});
it('preserves motor subtype 998 without treating it as a category; supports mixed and nonmotor objects', () => {
  const raw = structure();
  const metadata = { ...raw, StructureInfo: { ...raw.StructureInfo, ObjInfo: {
    ...raw.StructureInfo.ObjInfo, VehicleInfoList: [{ ID: '12', VehicleAttributeInfo: { Type: 998 }, Position: '0,1;10000,9999' }],
    NonMotorVehicleInfoList: [{ ID: 12 }], ObjectList: [{ ObjectID: 'unknown', ObjectType: 998 }],
  } } };
  const objects = projectObjects(source(metadata), []);
  expect(objects.map((o) => o.category)).toEqual(['PERSON', 'MOTOR_VEHICLE', 'NON_MOTOR_VEHICLE', 'UNKNOWN']);
  expect(objects[1]).toMatchObject({ sourceIdentifiers: { ID: '12' }, sourceSubtypeCode: '998', sourceCategoryCode: null });
});
it('maps only verified Alarm type codes and keeps distinct Alarm namespaces', () => {
  const objects = projectObjects({ ...source({ RelatedObjects: { ObjectList: [2, 4, 3, 998].map((ObjectType) => ({ ObjectID: 12, ObjectType })) } }), kind: 'ALARM' }, []);
  expect(objects.map((o) => o.category)).toEqual(['PERSON', 'MOTOR_VEHICLE', 'NON_MOTOR_VEHICLE', 'UNKNOWN']);
  expect(objects[0]).toMatchObject({ sourceIdentifiers: { ObjectID: 12 }, sourceCategoryCode: '2', sourceList: 'RelatedObjects.ObjectList' });
});
it.each([undefined, null, '100,200', '100,200;50,300', '-1,2;3,4', '0,0;10001,10', { x: 1 }])('never invents a rectangle from missing/invalid Position %j', (Position) => {
  const [object] = projectObjects(source({ StructureInfo: { ObjInfo: { PersonInfoList: [{ Position }] } } }), []);
  expect(object).toMatchObject({ xMin: null, yMin: null, xMax: null, yMax: null,
    coordinateStatus: Position == null ? 'MISSING' : 'INVALID' });
});
it('does not guess image links or link across notification, event, image type, live origin or ambiguous indices', () => {
  const candidates = [ { ...image('other-notification', 1, '1'), notificationId: 'other' },
    { ...image('other-event', 1, '1'), eventId: 'other' }, { ...image('live', 1, '1'), origin: 'NVR_LIVE' }, image('wrong-type', 1, '2') ];
  expect(projectObjects(source(structure()), candidates)[0]).toMatchObject({ fullFrameSnapshotId: null, cropSnapshotId: null });
  expect(projectObjects(source(structure()), [image('a', 1, '1'), image('b', 1, '1')])[0]!.fullFrameSnapshotId).toBeNull();
});
it('ingestion is atomic and idempotent; historical projection needs only persisted metadata and is repeatable', async () => {
  const f = fixtureStore();
  const raw = structure();
  raw.StructureInfo.ImageInfoList.push({ Index: 2, Type: 2, Width: 100, Height: 200, Data: jpeg.toString('base64') });
  const results = await Promise.all([1, 2, 3].map(() => ingestNotification(config, f.store, raw, 'STRUCTURE')));
  const eventId = results[0]!.eventId;
  expect(f.state().objects).toHaveLength(1);
  expect(f.state().objects[0]).toMatchObject({ fullFrameSnapshotId: f.state().snapshots[0]!.id, cropSnapshotId: f.state().snapshots[1]!.id });
  await ingestNotification(config, f.store, { ...alarm(), RelatedObjects: { ObjectList: [{ ObjectID: 12, ObjectType: 2 }] } }, 'ALARM');
  expect(f.state().objects).toHaveLength(2); // No ObjectID/PersonID identity merge.
  expect(f.state().events).toHaveLength(1);
  const notificationId = f.state().notifications[0]!.id;
  f.state().objects.splice(0); // Simulate pre-Phase-4 historical data, not production.
  expect(await projectStoredNotification(f.prisma, eventId, notificationId)).toEqual({ count: 1 });
  expect(await projectStoredNotification(f.prisma, eventId, notificationId)).toEqual({ count: 0 });
  expect(await projectStoredNotification(f.prisma, 'wrong-event', notificationId)).toBeNull();
  expect(f.state().snapshots).toHaveLength(2);
  expect(f.state().events[0]!.id).toBe(eventId);
  expect(JSON.stringify(f.state())).not.toContain(jpeg.toString('base64'));
});
it('does not manufacture object rows from counts alone or mutate the original metadata', () => {
  const metadata = { StructureInfo: { ObjInfo: { PersonNum: 2, VehicleNum: 1 } } };
  const before = JSON.stringify(metadata);
  expect(projectObjects(source(metadata), [])).toEqual([]);
  expect(JSON.stringify(metadata)).toBe(before);
});
it('migration is additive and enforces notification-local image ownership and object identity', () => {
  const sql = readFileSync('prisma/migrations/20261014080000_structured_uniview_objects/migration.sql', 'utf8');
  expect(sql).not.toMatch(/\b(?:DROP|DELETE|UPDATE|TRUNCATE)\s+(?:TABLE|FROM|"SecurityEvent"|"EventSnapshot")/);
  expect(sql).toContain('current_database()');
  expect(sql).toContain('UNIQUE INDEX "UniviewObject_notificationId_sourceList_sourceOrdinal_key"');
  expect(sql).toContain('FOREIGN KEY ("eventId", "notificationId", "fullFrameSnapshotId")');
  expect(sql).toContain('FOREIGN KEY ("eventId", "notificationId", "cropSnapshotId")');
  expect(sql).toContain('"xMax"<=10000');
});
it('keeps repeated native IDs as separate list entries and projects object-specific source times', () => {
  const metadata = { StructureInfo: { ObjInfo: { PersonInfoList: [{ PersonID: '12', TimeStamp: 1002 }, { PersonID: '12' }] } } };
  const objects = projectObjects(source(metadata), []);
  expect(objects).toHaveLength(2);
  expect(objects.map((o) => o.sourceOrdinal)).toEqual([0, 1]);
  expect(objects[0]).toMatchObject({ sourceTimestamp: new Date(1002000), timestampBasis: 'OBJECT_TIMESTAMP', sourceIdentifiers: { PersonID: '12' } });
  expect(objects[1]).toMatchObject({ sourceTimestamp: new Date(1001000), timestampBasis: 'NOTIFICATION_REPORTED_AT' });
});
it('persists mixed object lists with distinct explicit crop associations in one canonical event', async () => {
  const f = fixtureStore(), raw = structure();
  const payload = { ...raw, StructureInfo: { ...raw.StructureInfo,
    ObjInfo: { ...raw.StructureInfo.ObjInfo, VehicleNum: 1, VehicleInfoList: [{ ID: 99, LargePicAttachIndex: 1, SmallPicAttachIndex: 3,
      Position: '100,200;400,500', VehicleAttributeInfo: { Type: 998 }, RuleInfo: { RuleType: 3, PointNum: 0 } }] },
    ImageInfoList: [ ...raw.StructureInfo.ImageInfoList, ...[2, 3].map((Index) => ({ Index, Type: 2, Data: jpeg.toString('base64') })) ],
  } };
  await ingestNotification(config, f.store, payload, 'STRUCTURE');
  expect(f.state().events).toHaveLength(1);
  expect(f.state().objects).toHaveLength(2);
  expect(f.state().objects.map((o) => o.category)).toEqual(['PERSON', 'MOTOR_VEHICLE']);
  expect(f.state().objects[0]!.cropSnapshotId).toBe(f.state().snapshots[1]!.id);
  expect(f.state().objects[1]!.cropSnapshotId).toBe(f.state().snapshots[2]!.id);
  expect(f.state().objects[1]!.fullFrameSnapshotId).toBe(f.state().objects[0]!.fullFrameSnapshotId);
  expect(f.state().notifications[0]).toMatchObject({ metadata: { StructureInfo: { ObjInfo: { VehicleInfoList: [{ RuleInfo: { RuleType: 3, PointNum: 0 } }] } } } });
});
it('rolls back a failed object write rather than acknowledging a partially projected notification', async () => {
  const f = fixtureStore(true);
  await expect(ingestNotification(config, f.store, structure(), 'STRUCTURE')).rejects.toThrow('object write unavailable');
  expect(f.state()).toEqual({ events: [], notifications: [], snapshots: [], objects: [] });
});
