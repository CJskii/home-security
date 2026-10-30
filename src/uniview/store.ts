import type { PrismaClient, Prisma } from '../generated/prisma/client.js';
import type { Config } from '../config.js';
import { projectObjects } from './object-projection.js';
import type { UniviewStore } from './ingest.js';
const earlier = (a: Date | null, b: Date | null) => !a ? b : !b ? a : a < b ? a : b;
const later = (a: Date | null, b: Date | null) => !a ? b : !b ? a : a > b ? a : b;
export function createUniviewStore(prisma: PrismaClient, config: Config): UniviewStore {
  return { commit: (data) => prisma.$transaction(async (tx) => {
    const n = data.notification;
    const identity = { sourceInstallationId: data.sourceInstallationId, nvrChannel: n.nvrChannel, alarmType: n.alarmType, relatedId: n.relatedId };
    const event = await tx.securityEvent.upsert({ where: { univiewDetectionIdentity: identity }, update: {}, create: {
      ...identity, camera: data.camera, firstReceivedAt: data.receivedAt, lastReceivedAt: data.receivedAt,
    } });
    const notificationIdentity = { eventId: event.id, kind: n.kind, contentHash: n.contentHash };
    if (await tx.univiewNotification.findUnique({ where: { univiewNotificationIdentity: notificationIdentity } })) return { eventId: event.id, newNotification: false };
    const notification = await tx.univiewNotification.create({ data: {
      ...notificationIdentity, reportedAt: n.reportedAt, receivedAt: data.receivedAt,
      personCount: n.personCount, vehicleCount: n.vehicleCount, objectType: n.objectType,
      metadata: n.metadata as Prisma.InputJsonObject, schemaVersion: 2,
    } });
    await tx.securityEvent.update({ where: { id: event.id }, data: {
      alarmSeen: event.alarmSeen || n.kind === 'ALARM',
      occurredAt: n.kind === 'ALARM' ? earlier(event.occurredAt, n.reportedAt) : event.occurredAt,
      sourceUpdatedAt: later(event.sourceUpdatedAt, n.reportedAt),
      firstReceivedAt: earlier(event.firstReceivedAt, data.receivedAt)!, lastReceivedAt: later(event.lastReceivedAt, data.receivedAt)!,
    } });
    const images = [];
    for (const snapshot of data.snapshots) {
      images.push(await tx.eventSnapshot.create({ data: { ...snapshot, eventId: event.id, notificationId: notification.id } }));
    }
    const objects = projectObjects(notification, images);
    if (objects.length) await tx.univiewObject.createMany({ data: objects, skipDuplicates: true });
    return { eventId: event.id, newNotification: true };
  }, { isolationLevel: 'Serializable', maxWait: config.DB_CHECK_TIMEOUT_MS, timeout: 5000 }) };
}

// Targeted historical projection from persisted metadata only; no media/NVR access.
// Caller supplies both UUIDs; the lookup fences notification ownership.
export async function projectStoredNotification(prisma: PrismaClient, eventId: string, notificationId: string) {
  return prisma.$transaction(async (tx) => {
    const source = await tx.univiewNotification.findUnique({
      where: { eventId_id: { eventId, id: notificationId } }, include: { snapshots: true },
    });
    if (!source) return null;
    const objects = projectObjects(source, source.snapshots);
    if (!objects.length) return { count: 0 };
    return tx.univiewObject.createMany({ data: objects, skipDuplicates: true });
  }, { isolationLevel: 'Serializable', maxWait: 5000, timeout: 5000 });
}

// Bounded selected-event repair for pre-projection historical notifications.
export async function projectStoredEvent(prisma: PrismaClient, eventId: string, installationId: string, signal?: AbortSignal) {
  const event = await prisma.securityEvent.findFirst({ where: { id:eventId,sourceInstallationId:installationId },
    select: { notifications:{select:{id:true},orderBy:[{receivedAt:'asc'},{id:'asc'}],take:33} } });
  if (!event) return null;
  if (event.notifications.length > 32) throw new Error('Selected projection limit');
  let inserted=0;
  for (const notification of event.notifications) {
    signal?.throwIfAborted();
    inserted+=(await projectStoredNotification(prisma,eventId,notification.id))?.count ?? 0;
  }
  return {notifications:event.notifications.length,inserted};
}
