import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { createUniviewStore } from '../src/uniview/store.js';
import { loadConfig } from '../src/config.js';
export const config = loadConfig({ DATABASE_URL: 'postgresql://test:secret@invalid/security', LOG_LEVEL: 'silent',
  UNIVIEW_ENABLED: 'true', UNIVIEW_INSTALLATION_ID: '17b01e57-cc3d-4db5-9bdd-f7d89e8149bb', UNIVIEW_NVR_IP: '10.0.0.1',
  UNIVIEW_CAMERA_MAP: '{"1":"camera_1","2":"camera_2"}', SHUTDOWN_TIMEOUT_MS: '30000' });
// Synthetic JPEG marker fixture: no captured residential image bytes in tests.
export const jpeg = Buffer.from([255,216,255,192,0,11,8,8,112,15,0,1,1,17,0,255,218,0,8,1,1,0,0,63,0,1,2,3,255,217]);
export const alarm = (related: string | number = 'one', channel: string | number = 1) => ({ AlarmInfo: { AlarmSrcID: channel, AlarmType: 'EnterArea', RelatedID: related, TimeStamp: 1000 } });
export const structure = (related = 'one', data: unknown = jpeg.toString('base64')) => ({ SrcID: 1, AlarmType: 'EnterArea', RelatedID: related, TimeStamp: 1001,
  NotificationType: 0, StructureInfo: { ObjInfo: { PersonNum: 1, VehicleNum: 0,
    PersonInfoList: [{ PersonID: 12, Position: '7447,825;7981,2410', LargePicAttachIndex: 1, SmallPicAttachIndex: 2, RuleInfo: { RuleType: 3, PointNum: 0 } }] },
    ImageInfoList: [{ Index: 1, Type: 1, Width: 3840, Height: 2160, Data: data }] } });
// Serialized database double models the unique identities; transactions clone state
// so rollback cannot leak partially-written records. SQL constraints are checked separately.
export function fixtureStore(failObjectWrites = false) {
  type Row = Record<string, unknown> & { id: string };
  let state = { events: [] as Row[], notifications: [] as Row[], snapshots: [] as Row[], objects: [] as Row[] };
  let tail = Promise.resolve(); const calls: { options: unknown; identity: unknown }[] = [];
  const prisma = { async $transaction(work: (tx: unknown) => Promise<unknown>, options: unknown) {
    const previous = tail; let release!: () => void; tail = new Promise<void>((resolve) => { release = resolve; });
    await previous; const draft = structuredClone(state);
    const tx = {
      securityEvent: {
        upsert: async ({ where, create }: { where: { univiewDetectionIdentity: Record<string, unknown> }; create: Record<string, unknown> }) => {
          calls.push({ options, identity: where });
          const existing = draft.events.find((row) => Object.entries(where.univiewDetectionIdentity).every(([k, v]) => row[k] === v));
          if (existing) return existing;
          const row = { id: randomUUID(), alarmSeen: false, occurredAt: null, sourceUpdatedAt: null, nativeEndedAt: null, ...create };
          draft.events.push(row); return row;
        },
        update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => Object.assign(draft.events.find((row) => row.id === where.id)!, data),
      },
      univiewNotification: {
        findUnique: async ({ where }: { where: { univiewNotificationIdentity?: Record<string, unknown>; eventId_id?: { eventId: string; id: string } } }) => {
          const identity = where.univiewNotificationIdentity ?? where.eventId_id!;
          const row = draft.notifications.find((r) => Object.entries(identity).every(([k, v]) => r[k] === v));
          return row ? { ...row, snapshots: draft.snapshots.filter((s) => s.notificationId === row.id) } : null;
        },
        create: async ({ data }: { data: Record<string, unknown> }) => { const row = { id: randomUUID(), ...data }; draft.notifications.push(row); return row; },
      },
      eventSnapshot: { create: async ({ data }: { data: Record<string, unknown> }) => { const row = { id: randomUUID(), ...data }; draft.snapshots.push(row); return row; } },
      univiewObject: { createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
        if (failObjectWrites) throw new Error('object write unavailable');
        let count = 0;
        for (const object of data) {
          if (draft.objects.some((o) => o.notificationId === object.notificationId && o.sourceList === object.sourceList && o.sourceOrdinal === object.sourceOrdinal)) continue;
          draft.objects.push({ id: randomUUID(), ...object }); count++;
        }
        return { count };
      } },
    };
    try { const result = await work(tx); state = draft; return result; } finally { release(); }
  } } as unknown as PrismaClient;
  return { prisma, store: createUniviewStore(prisma, config), state: () => state, calls };
}
