import type { PrismaClient } from '../generated/prisma/client.js';
import { z } from 'zod';
import { pictureReferenceSchema } from './client-schemas.js';
import { RESOLUTION_LIMITS, referenceProvenanceSchema, referenceStatuses, type HistoricalImageStore } from './historical-image-resolution.js';

export function createHistoricalImageStore(prisma: PrismaClient): HistoricalImageStore {
  return {
    load: (id) => prisma.securityEvent.findUnique({ where: { id }, select: {
      id: true, sourceInstallationId: true, nvrChannel: true, alarmType: true,
      notifications: { select: { id: true, eventId: true, reportedAt: true, metadata: true }, orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }], take: RESOLUTION_LIMITS.notifications + 1 },
      snapshots: { where: { origin: 'NVR_PUSH', imageType: { in: ['1', '2'] } }, orderBy: { id: 'asc' }, take: RESOLUTION_LIMITS.snapshots + 1,
        select: { id: true, eventId: true, notificationId: true, origin: true, status: true, imageType: true, sha256: true, sourceImageIndex: true, capturedAt: true,
          nvrPictureName: true, nvrPictureSize: true, nvrPictureType: true, nvrRecordId: true, referenceVersion: true, referenceStatus: true, referenceResolvedAt: true } },
    } }),
    async save(installationId, snapshot, update) {
      const ref = update.reference;
      if (ref && (update.status !== 'VERIFIED' || ref.provenance.originalSha256 !== snapshot.sha256 || String(ref.picture.Type) !== snapshot.imageType)) throw new Error('Invalid verified reference');
      const picture = ref ? pictureReferenceSchema.parse(ref.picture) : undefined;
      const provenance = ref ? referenceProvenanceSchema.parse(ref.provenance) : undefined;
      const recordId = ref ? z.string().min(1).max(256).nullable().parse(ref.recordId) : null;
      if (picture && picture.Size > 32_000_000) throw new Error('Invalid reference size');
      const status = z.enum(referenceStatuses).parse(update.status);
      const reason = z.string().regex(/^[a-z0-9_]{1,64}$/).nullable().parse(update.reason);
      z.date().parse(update.checkedAt);
      const result = await prisma.eventSnapshot.updateMany({ where: {
        id: snapshot.id, eventId: snapshot.eventId, notificationId: snapshot.notificationId,
        sha256: snapshot.sha256, status: snapshot.status, referenceVersion: snapshot.referenceVersion,
        origin: 'NVR_PUSH', imageType: snapshot.imageType, sourceImageIndex: snapshot.sourceImageIndex, capturedAt: snapshot.capturedAt, event: { sourceInstallationId: installationId },
      }, data: {
        referenceStatus: status, referenceFailureCode: reason, referenceCheckedAt: update.checkedAt,
        referenceVersion: { increment: 1 },
        ...(update.status === 'VERIFIED' ? { referenceVerifiedAt: update.checkedAt } : {}),
        ...(picture && provenance ? {
          nvrPictureName: picture.Name, nvrPictureSize: picture.Size, nvrPictureType: picture.Type, nvrRecordId: recordId,
          referenceResolvedAt: update.checkedAt, referenceProvenance: provenance,
        } : {}),
      } });
      return result.count === 1;
    },
  };
}
