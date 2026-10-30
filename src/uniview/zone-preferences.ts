import { z } from 'zod';
import type { PrismaClient } from '../generated/prisma/client.js';
import { zoneNameSchema } from './zones.js';

export const zonePreferenceInput = z.object({
  displayName: z.preprocess(v => typeof v === 'string' && !v.trim() ? null : v, zoneNameSchema.nullable()),
  interested: z.boolean(),
  expectedGeometryFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const zonePreferenceSchema = z.object({
  zoneId: z.uuid(), displayName: zoneNameSchema.nullable(), interested: z.boolean(), updatedAt: z.iso.datetime(),
}).strict();
export type ZonePreferenceInput = z.infer<typeof zonePreferenceInput>;
export type ZonePreference = z.infer<typeof zonePreferenceSchema>;
export class ZonePreferenceConflict extends Error {}
export interface ZonePreferenceStore {
  // null means the additive table is not yet available (read-only host development).
  list(installation: string, channel: number): Promise<ZonePreference[] | null>;
  save?: (installation: string, channel: number, zoneId: string, input: ZonePreferenceInput) => Promise<ZonePreference | null>;
}
const scope = (installation: string, channel: number) => ({
  sourceInstallationId: z.uuid().parse(installation), channel: z.number().int().min(1).max(2).parse(channel),
});
const present = (row: { zoneId: string; displayName: string | null; interested: boolean; updatedAt: Date }) =>
  zonePreferenceSchema.parse({ ...row, updatedAt: row.updatedAt.toISOString() });
export function createZonePreferenceStore(prisma: PrismaClient): Required<ZonePreferenceStore> {
  return {
    async list(installation, channel) {
      try { return (await prisma.zonePreference.findMany({ where: { zone: scope(installation, channel) }, take: 4 })).map(present); }
      catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'P2021') return null;
        throw error;
      }
    },
    async save(installation, channel, zoneId, value) {
      const where = { ...scope(installation, channel), id: z.uuid().parse(zoneId) }, input = zonePreferenceInput.parse(value);
      try {
        return await prisma.$transaction(async tx => {
          const zone = await tx.univiewZone.findFirst({ where, select: { versions: { orderBy: { revision: 'desc' }, take: 1, select: { geometryFingerprint: true } } } });
          if (!zone) return null;
          if (zone.versions[0]?.geometryFingerprint !== input.expectedGeometryFingerprint) throw new ZonePreferenceConflict('Zone geometry changed. Review it before saving.');
          const previous = await tx.zonePreference.findUnique({ where: { zoneId } });
          if (previous && previous.displayName === input.displayName && previous.interested === input.interested) return present(previous);
          const data = { displayName: input.displayName, interested: input.interested };
          return present(await tx.zonePreference.upsert({ where: { zoneId }, create: { zoneId, ...data }, update: data }));
        }, { isolationLevel: 'Serializable', maxWait: 5000, timeout: 5000 });
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'P2034') throw new ZonePreferenceConflict('Zone configuration changed. Review it before saving.');
        throw error;
      }
    },
  };
}
