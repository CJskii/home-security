import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { createHistoricalImageStore } from '../src/uniview/historical-image-store.js';
import { RESOLUTION_LIMITS, type ResolutionSnapshot, type ResolutionUpdate } from '../src/uniview/historical-image-resolution.js';

const sha256 = 'a'.repeat(64), checkedAt = new Date('2026-10-14T12:00:00Z');
const snapshot: ResolutionSnapshot = { id: 'snapshot', eventId: 'event', notificationId: 'notification', origin: 'NVR_PUSH', status: 'RECEIVED', imageType: '2',
  sha256, sourceImageIndex: 2, capturedAt: checkedAt, nvrPictureName: null, nvrPictureSize: null, nvrPictureType: null, nvrRecordId: null, referenceVersion: 3, referenceResolvedAt: null };
const update: ResolutionUpdate = { status: 'VERIFIED', reason: null, checkedAt, reference: {
  picture: { Type: 2, Name: 'fixture_crop', Size: 1234 }, recordId: 'fixture-record', provenance: {
    version: 1, method: 'smart_object_search_sha256', originalSha256: sha256, sourceTime: checkedAt.toISOString(), timeBasis: 'snapshot_capture',
    queryBegin: 1700000000, queryEnd: 1700000004, queryObjectType: 2, candidateTime: 1700000002, sceneSha256: 'b'.repeat(64),
  },
} };
function setup(count = 1) {
  const findUnique = vi.fn(async () => null), updateMany = vi.fn<(args: Record<string, unknown>) => Promise<{ count: number }>>().mockResolvedValue({ count });
  const prisma = { securityEvent: { findUnique }, eventSnapshot: { updateMany } } as unknown as PrismaClient;
  return { store: createHistoricalImageStore(prisma), findUnique, updateMany };
}

it('loads only the selected event and original typed snapshots with bounded source metadata', async () => {
  const f = setup(); await f.store.load('event');
  expect(f.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'event' }, select: expect.objectContaining({
    snapshots: expect.objectContaining({ where: { origin: 'NVR_PUSH', imageType: { in: ['1', '2'] } }, take: RESOLUTION_LIMITS.snapshots + 1 }),
    notifications: expect.objectContaining({ take: RESOLUTION_LIMITS.notifications + 1 }),
  }) }));
});

it('updates only enrichment fields, fenced by ownership, original hash and compare-and-swap version', async () => {
  const f = setup(); expect(await f.store.save('installation', snapshot, update)).toBe(true);
  const [args] = f.updateMany.mock.calls[0]! as unknown as [{ where: Record<string, unknown>; data: Record<string, unknown> }];
  expect(args.where).toMatchObject({ id: 'snapshot', eventId: 'event', notificationId: 'notification', sha256, referenceVersion: 3, event: { sourceInstallationId: 'installation' } });
  expect(args.data).toMatchObject({ nvrPictureName: 'fixture_crop', nvrPictureSize: 1234, nvrPictureType: 2, nvrRecordId: 'fixture-record',
    referenceStatus: 'VERIFIED', referenceVersion: { increment: 1 }, referenceVerifiedAt: checkedAt, referenceResolvedAt: checkedAt });
  expect(Object.keys(args.data).every((key) => key.startsWith('reference') || key.startsWith('nvr'))).toBe(true);
  expect(args.data).not.toHaveProperty('sha256'); expect(args.data).not.toHaveProperty('notificationId');
  expect(args.data.referenceProvenance).toEqual(update.reference!.provenance);
});

it('retains last verified reference metadata when an availability check fails', async () => {
  const f = setup(0);
  expect(await f.store.save('installation', snapshot, { status: 'NOT_FOUND', reason: 'verified_reference_not_found', checkedAt })).toBe(false);
  const args = f.updateMany.mock.calls[0]![0] as unknown as { data: Record<string, unknown> };
  expect(Object.keys(args.data).sort()).toEqual(['referenceCheckedAt', 'referenceFailureCode', 'referenceStatus', 'referenceVersion']);
});

it('rejects wrong-type/hash references and unbounded provenance before issuing SQL', async () => {
  const f = setup();
  await expect(f.store.save('installation', snapshot, { ...update, reference: { ...update.reference!, picture: { ...update.reference!.picture, Type: 1 } } })).rejects.toThrow();
  await expect(f.store.save('installation', snapshot, { ...update, reference: { ...update.reference!, provenance: { ...update.reference!.provenance, originalSha256: 'c'.repeat(64) } } })).rejects.toThrow();
  const unsafe = { ...update.reference!.provenance, Data: 'must-not-be-persisted' };
  await expect(f.store.save('installation', snapshot, { ...update, reference: { ...update.reference!, provenance: unsafe } })).rejects.toThrow();
  expect(f.updateMany).not.toHaveBeenCalled();
});

it('migration is additive and preserves original evidence, canonical identities, historical integration tables and migration history', () => {
  const sql = readFileSync(new URL('../prisma/migrations/20261014070000_historical_image_references/migration.sql', import.meta.url), 'utf8');
  expect(sql).toContain("current_database() <> 'security_events'"); expect(sql).toContain("SET LOCAL lock_timeout = '3s'");
  expect(sql).not.toMatch(/\b(DROP|UPDATE|DELETE|TRUNCATE|INSERT)\b/i);
  expect(sql).not.toMatch(/Frigate|SecurityEvent|_prisma_migrations|ADD COLUMN "(?:sha256|imageType|notificationId)"/);
  expect(sql).toContain('"nvrPictureType" IN (1,2)'); expect(sql).toContain('"imageType"="nvrPictureType"::text');
  expect(sql).toContain('"notificationId" IS NOT NULL'); expect(sql).toMatch(/"referenceStatus"<>'VERIFIED'/);
  expect(sql).toContain("DEFAULT 'UNRESOLVED'"); expect(sql.trim().endsWith('COMMIT;')).toBe(true);
});
