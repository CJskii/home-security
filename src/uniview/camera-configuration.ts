import { z } from 'zod';
import type { PrismaClient, Prisma } from '../generated/prisma/client.js';
import { videoStreamsSchema } from './client-schemas.js';
import { zoneNameSchema, type ObservedZone } from './zones.js';
import { createZoneStore } from './zone-store.js';
import { canonical } from './schemas.js';
export const cameraSnapshotSchema = z.object({name:zoneNameSchema.nullable(),streams:videoStreamsSchema}).strict();
export type CameraSnapshot = z.infer<typeof cameraSnapshotSchema>;
export interface CameraConfigurationState {
  snapshot: unknown; lastSuccessfulAt: Date | null; lastAttemptAt: Date; failed: boolean;
}
export interface CameraConfigurationStore {
  get(installation: string, channel: number): Promise<CameraConfigurationState | null>;
  observe(installation: string, channel: number, zones: ObservedZone[], snapshot: CameraSnapshot, at: Date): Promise<void>;
  failed(installation: string, channel: number, at: Date): Promise<void>;
}
export function createCameraConfigurationStore(prisma: PrismaClient): CameraConfigurationStore {
  const key = (sourceInstallationId: string, channel: number) => ({sourceInstallationId_channel:{sourceInstallationId:z.uuid().parse(sourceInstallationId),channel:z.number().int().min(1).max(2).parse(channel)}});
  return {
    get: (installation,channel) => prisma.cameraConfiguration.findUnique({where:key(installation,channel)}),
    async observe(installation,channel,zones,input,at) {
      const snapshot=cameraSnapshotSchema.parse(input),where=key(installation,channel);
      await prisma.$transaction(async tx => {
        const previous=await tx.cameraConfiguration.findUnique({where});
        if(previous && previous.lastAttemptAt > at) return;
        await createZoneStore(prisma,tx).observe(installation,channel,zones,at);
        // Heartbeat timestamps are necessary observations; don't rewrite unchanged JSON.
        const changed=canonical(previous?.snapshot??null)!==canonical(snapshot);
        await tx.cameraConfiguration.upsert({where,create:{...where.sourceInstallationId_channel,snapshot,lastSuccessfulAt:at,lastAttemptAt:at,failed:false},
          update:{...(changed?{snapshot:snapshot as Prisma.InputJsonValue}:{}),lastSuccessfulAt:at,lastAttemptAt:at,failed:false}});
      },{isolationLevel:'Serializable',maxWait:5000,timeout:5000});
    },
    async failed(installation,channel,at) {
      const where=key(installation,channel);
      await prisma.cameraConfiguration.upsert({where,create:{...where.sourceInstallationId_channel,lastAttemptAt:at,failed:true},
        update:{lastAttemptAt:at,failed:true}});
    },
  };
}
export function configurationStatus(state: CameraConfigurationState | null, now=Date.now()) {
  return {state:!state?.lastSuccessfulAt?'unavailable':state.failed||now-state.lastSuccessfulAt.getTime()>12*60*1000?'stale':'fresh',
    lastSuccessfulAt:state?.lastSuccessfulAt?.toISOString()??null,lastAttemptAt:state?.lastAttemptAt.toISOString()??null,
    error:state?.failed?'nvr_configuration_unavailable':null,intervalSeconds:600};
}
