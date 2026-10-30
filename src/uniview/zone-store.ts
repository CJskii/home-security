import type { PrismaClient, Prisma } from '../generated/prisma/client.js';
import { zoneVersionSelect } from '../events/store.js';
import { z } from 'zod';
import { zoneRuleConfigurationSchema } from './client-schemas.js';
import { canonical } from './schemas.js';
import { geometryFingerprint, polygonSchema, usablePolygon } from './zone-geometry.js';
import { zoneNameSchema, type ObservedZone, type ZoneVersion } from './zones.js';
import type { ZoneEnrichmentStore, ZoneEvidenceWrite } from './zone-enrichment.js';
const installationSchema = z.uuid();
const channelSchema = z.number().int().min(1).max(2);
const slotSchema = z.number().int().min(0).max(3);
const observedZoneSchema = z.object({ slot: slotSchema, enabled: z.boolean(), ruleEnabled: z.boolean(),
  polygon: z.union([polygonSchema, z.array(z.never()).length(0)]), name:zoneNameSchema.optional(), configuration:zoneRuleConfigurationSchema.optional(), geometryFingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

// Short serializable metadata transactions; competing instances retry unique/serialization conflicts.
async function serial<T>(prisma: PrismaClient, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await prisma.$transaction(work, { isolationLevel: 'Serializable', maxWait: 5000, timeout: 5000 }); }
    catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
      if (attempt >= 2 || code !== 'P2002' && code !== 'P2034') throw error;
    }
  }
}
export function createZoneStore(prisma: PrismaClient, transaction?: Prisma.TransactionClient, includeConfiguration = true) {
  const observeTransaction = (work: (tx: Prisma.TransactionClient) => Promise<void>) => transaction ? work(transaction) : serial(prisma,work);
  return {
    async observe(installationId: string, channel: number, zones: ObservedZone[], observedAt: Date) {
      installationSchema.parse(installationId); channelSchema.parse(channel); z.date().parse(observedAt);
      const inputs = z.array(observedZoneSchema).max(4).parse(zones);
      if (new Set(inputs.map((v) => v.slot)).size !== inputs.length || inputs.some((v) => geometryFingerprint(v.polygon) !== v.geometryFingerprint || (v.enabled || v.polygon.length > 0) && !usablePolygon(v.polygon))) throw new Error('Invalid zone observation');
      await observeTransaction(async (tx) => {
        for (const slot of [0, 1, 2, 3]) {
          let zone = await tx.univiewZone.upsert({ where: { univiewZoneSlot: { sourceInstallationId: installationId, channel, slot } }, update: {},
            create: { sourceInstallationId: installationId, channel, slot, displayName: `Channel ${channel} zone ${slot}`, nameUpdatedAt: observedAt } });
          const input = inputs.find((v) => v.slot === slot);
          if (!input) continue; // An omitted slot is unknown, not disabled.
          const previous = await tx.univiewZoneVersion.findFirst({ where: { zoneId: zone.id }, orderBy: { revision: 'desc' } });
          if (previous && observedAt < previous.lastObservedAt) continue;
          if (input.name && input.name !== zone.displayName) zone = await tx.univiewZone.update({where:{id:zone.id},data:{displayName:input.name,nameUpdatedAt:observedAt}});
          if (previous && previous.geometryFingerprint === input.geometryFingerprint && previous.enabled === input.enabled
            && previous.ruleEnabled === input.ruleEnabled && previous.displayName === zone.displayName && canonical(previous.configuration ?? null) === canonical(input.configuration ?? null)) {
            await tx.univiewZoneVersion.update({ where: { id: previous.id }, data: { lastObservedAt: observedAt } });
          } else {
            await tx.univiewZoneVersion.create({ data: { zoneId: zone.id, revision: (previous?.revision ?? 0) + 1,
              displayName: zone.displayName, nameEffectiveAt: zone.nameUpdatedAt, enabled: input.enabled, ruleEnabled: input.ruleEnabled,
              ...(input.configuration ? {configuration:input.configuration} : {}), polygon: input.polygon, geometryFingerprint: input.geometryFingerprint, observedAt, lastObservedAt: observedAt } });
          }
        }
      });
    },
    async rename(installationId: string, channel: number, slot: number, displayName: string, at = new Date()) {
      installationSchema.parse(installationId); channelSchema.parse(channel); slotSchema.parse(slot); z.date().parse(at);
      const name = zoneNameSchema.parse(displayName);
      return serial(prisma, async (tx) => {
        const zone = await tx.univiewZone.findUnique({ where: { univiewZoneSlot: { sourceInstallationId: installationId, channel, slot } } });
        if (!zone) return null;
        if (zone.displayName === name) return zone;
        if (at < zone.nameUpdatedAt) throw new Error('Stale zone rename');
        const previous = await tx.univiewZoneVersion.findFirst({ where: { zoneId: zone.id }, orderBy: { revision: 'desc' } });
        if (previous && at < previous.lastObservedAt) throw new Error('Stale zone rename');
        const renamed = await tx.univiewZone.update({ where: { id: zone.id }, data: { displayName: name, nameUpdatedAt: at } });
        if (previous) {
          // Copy a known observation, not an invented new NVR observation. The name is
          // effective now; confirmation coverage resumes on a subsequent NVR read.
          await tx.univiewZoneVersion.create({ data: { zoneId: zone.id, revision: previous.revision + 1,
            displayName: name, nameEffectiveAt: at, enabled: previous.enabled, ruleEnabled: previous.ruleEnabled,
            ...(previous.configuration ? {configuration:previous.configuration as Prisma.InputJsonValue} : {}), polygon: previous.polygon as Prisma.InputJsonValue, geometryFingerprint: previous.geometryFingerprint,
            observedAt: previous.lastObservedAt, lastObservedAt: previous.lastObservedAt } });
        }
        return renamed;
      });
    },
    // Internal metadata read for future names/filtering, with bounded history.
    async list(installationId: string, channel: number) {
      installationSchema.parse(installationId); channelSchema.parse(channel);
      return prisma.univiewZone.findMany({ where: { sourceInstallationId: installationId, channel }, orderBy: { slot: 'asc' },
        take: 4, include: { versions: { select:{...zoneVersionSelect,...(includeConfiguration?{configuration:true}:{})},orderBy: { revision: 'desc' }, take: 32 } } });
    },
  };
}
export type ZoneStore = ReturnType<typeof createZoneStore>;
export function createZoneEnrichmentStore(prisma: PrismaClient): ZoneEnrichmentStore {
  return {
    load: (id) => prisma.securityEvent.findUnique({ where: { id }, select: {
      id: true, sourceInstallationId: true, nvrChannel: true, alarmType: true,
      objects: { take: 65, orderBy: { id: 'asc' }, include: { fullFrameSnapshot: true, cropSnapshot: true, zoneEvidence: true } },
    } }),
    async versions(installationId, channel, begin, end) {
      const rows = await prisma.univiewZoneVersion.findMany({ where: {
        zone: { sourceInstallationId: installationId, channel }, observedAt: { lte: end }, lastObservedAt: { gte: begin }, nameEffectiveAt: { lte: end },
      }, include: { zone: { select: { slot: true } } }, orderBy: [{ zoneId: 'asc' }, { revision: 'asc' }], take: 257 });
      return rows.map((v): ZoneVersion => ({ ...v, slot: v.zone.slot, polygon: Array.isArray(v.polygon) && v.polygon.length === 0 ? [] : polygonSchema.parse(v.polygon) }));
    },
    async save(installationId: string, eventId: string, write: ZoneEvidenceWrite) {
      return serial(prisma, async (tx) => {
        const object = await tx.univiewObject.findFirst({ where: { id: write.objectId, eventId, event: { sourceInstallationId: installationId } }, include: { zoneEvidence: true, event: { select: { nvrChannel: true } } } });
        if (!object) return false;
        const existing = object.zoneEvidence;
        if (existing && existing.status !== 'UNKNOWN') return false;
        if (existing && Array.isArray(existing.sourceRules) && existing.sourceRules.length > 0 && canonical(existing.sourceRules) !== canonical(write.sourceRules)) throw new Error('Source rule evidence is immutable');
        const ids = [...new Set([...write.memberships.map((m) => m.zoneVersionId), ...(write.zoneVersionId ? [write.zoneVersionId] : [])])];
        const versions = await tx.univiewZoneVersion.findMany({ where: { id: { in: ids }, zone: { sourceInstallationId: installationId, channel: object.event.nvrChannel } } });
        if (versions.length !== ids.length) throw new Error('Invalid zone ownership');
        const data = { status: write.status, reason: write.reason, zoneVersionId: write.zoneVersionId,
          sourceRules: write.sourceRules as Prisma.InputJsonValue, provenance: write.provenance as Prisma.InputJsonObject, enrichedAt: write.enrichedAt };
        const changed = !existing || write.status !== existing.status || canonical(existing.sourceRules) !== canonical(write.sourceRules);
        if (changed && existing) await tx.objectZoneEvidence.update({ where: { objectId: write.objectId }, data });
        else if (!existing) await tx.objectZoneEvidence.create({ data: { objectId: write.objectId, ...data } });
        const inserted = write.memberships.length ? await tx.objectZoneMembership.createMany({ data: write.memberships.map((m) => ({ ...m, objectId: write.objectId })), skipDuplicates: true }) : { count: 0 };
        return changed || inserted.count > 0;
      });
    },
  };
}
