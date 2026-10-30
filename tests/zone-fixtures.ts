import { randomUUID } from 'node:crypto';
import type { PrismaClient, UniviewZone, UniviewZoneVersion, CameraConfiguration, ZonePreference } from '../src/generated/prisma/client.js';
import { createZoneStore } from '../src/uniview/zone-store.js';
import type { AccessZoneConfiguration } from '../src/uniview/client-schemas.js';
import type { Vertex } from '../src/uniview/zone-geometry.js';
import type { ZoneVersion } from '../src/uniview/zones.js';
export const installation = '17b01e57-cc3d-4db5-9bdd-f7d89e8149bb';
export const eventId = '27b01e57-cc3d-4db5-9bdd-f7d89e8149bb';
export const square = (low = 100, high = 9900): Vertex[] => [{ X: low, Y: low }, { X: high, Y: low }, { X: high, Y: high }, { X: low, Y: high }];
export const at = (hours: number) => new Date(Date.UTC(2026, 9, 14) + hours * 3600000);
export function configuration(): AccessZoneConfiguration {
  return { Rule: { Enabled: 1 }, Areas: { Num: 4, PolygonInfoList: [0, 1, 2, 3].map((ID) => ({ ID, Enabled: ID === 3 ? 0 : 1, PointNum: 4, PointList: square(ID * 100 + 100, 9900) })) } };
}
// Database double: metadata-only, serialized clone-on-commit transactions.
export function zoneDatabase() {
  let state = { zones: [] as UniviewZone[], versions: [] as UniviewZoneVersion[], configurations: [] as CameraConfiguration[], preferences: [] as ZonePreference[] };
  let tail = Promise.resolve();
  const snapshotUpdates: Record<string,unknown>[]=[];
  const txFor = (draft: typeof state) => ({
    cameraConfiguration: {
      findUnique:async({where}:{where:{sourceInstallationId_channel:{sourceInstallationId:string;channel:number}}})=>draft.configurations.find(v=>v.sourceInstallationId===where.sourceInstallationId_channel.sourceInstallationId && v.channel===where.sourceInstallationId_channel.channel)??null,
      upsert:async({where,create,update}:{where:{sourceInstallationId_channel:{sourceInstallationId:string;channel:number}};create:CameraConfiguration;update:Partial<CameraConfiguration>})=>{
        const row=draft.configurations.find(v=>v.sourceInstallationId===where.sourceInstallationId_channel.sourceInstallationId && v.channel===where.sourceInstallationId_channel.channel);
        if(row){snapshotUpdates.push(update);Object.assign(row,update);return row;}
        draft.configurations.push(create);return create;
      },
    },
    zonePreference: {
      findUnique: async ({where}:{where:{zoneId:string}}) => draft.preferences.find(p=>p.zoneId===where.zoneId)??null,
      upsert: async ({where,create,update}:{where:{zoneId:string};create:Omit<ZonePreference,'updatedAt'>;update:Pick<ZonePreference,'displayName'|'interested'>})=>{
        const old=draft.preferences.find(p=>p.zoneId===where.zoneId);
        if(old)return Object.assign(old,update,{updatedAt:new Date()});
        const row={...create,updatedAt:new Date()};draft.preferences.push(row);return row;
      },
    },
    univiewZone: {
      findFirst: async ({where}:{where:{id:string;sourceInstallationId:string;channel:number}})=>{
        const row=draft.zones.find(z=>z.id===where.id&&z.channel===where.channel&&z.sourceInstallationId===where.sourceInstallationId);
        return row?{versions:draft.versions.filter(v=>v.zoneId===row.id).sort((a,b)=>b.revision-a.revision).slice(0,1)}:null;
      },
      upsert: async ({ where, create }: { where: { univiewZoneSlot: Partial<UniviewZone> }; create: Omit<UniviewZone, 'id'> }) => {
        const row = draft.zones.find((v) => Object.entries(where.univiewZoneSlot).every(([k, val]) => v[k as keyof UniviewZone] === val));
        if (row) return row;
        const added = { id: randomUUID(), ...create }; draft.zones.push(added); return added;
      },
      findUnique: async ({ where }: { where: { univiewZoneSlot: Partial<UniviewZone> } }) => draft.zones.find((v) => Object.entries(where.univiewZoneSlot).every(([k, val]) => v[k as keyof UniviewZone] === val)) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Partial<UniviewZone> }) => Object.assign(draft.zones.find((v) => v.id === where.id)!, data),
      findMany: async ({ where }: { where: { sourceInstallationId: string; channel: number } }) => draft.zones.filter((v) => v.sourceInstallationId === where.sourceInstallationId && v.channel === where.channel)
        .map((v) => ({ ...v, versions: draft.versions.filter((version) => version.zoneId === v.id).sort((a, b) => b.revision - a.revision).slice(0, 32) })),
    },
    univiewZoneVersion: {
      findFirst: async ({ where }: { where: { zoneId: string } }) => draft.versions.filter((v) => v.zoneId === where.zoneId).sort((a, b) => b.revision - a.revision)[0] ?? null,
      create: async ({ data }: { data: Omit<UniviewZoneVersion, 'id'> }) => { const row = { id: randomUUID(), ...data }; draft.versions.push(row); return row; },
      update: async ({ where, data }: { where: { id: string }; data: Partial<UniviewZoneVersion> }) => Object.assign(draft.versions.find((v) => v.id === where.id)!, data),
    },
  });
  const prisma = { async $transaction(work: (tx: unknown) => Promise<unknown>) {
    const previous = tail; let release!: () => void; tail = new Promise<void>((resolve) => { release = resolve; });
    await previous; const draft = structuredClone(state);
    try { const result = await work(txFor(draft)); state = draft; return result; } finally { release(); }
  }, cameraConfiguration:{findUnique:async(args:Parameters<ReturnType<typeof txFor>['cameraConfiguration']['findUnique']>[0])=>txFor(state).cameraConfiguration.findUnique(args),upsert:async(args:Parameters<ReturnType<typeof txFor>['cameraConfiguration']['upsert']>[0])=>txFor(state).cameraConfiguration.upsert(args)}, zonePreference:{findMany:async({where}:{where:{zone:{sourceInstallationId:string;channel:number}}})=>state.preferences.filter(p=>state.zones.some(z=>z.id===p.zoneId&&z.sourceInstallationId===where.zone.sourceInstallationId&&z.channel===where.zone.channel))}, univiewZone: { findMany: async (args: Parameters<ReturnType<typeof txFor>['univiewZone']['findMany']>[0]) => txFor(state).univiewZone.findMany(args) } } as unknown as PrismaClient;
  return { prisma, snapshotUpdates, store: createZoneStore(prisma), state: () => state,
    versions: (): ZoneVersion[] => state.versions.map((v) => ({ ...v, slot: state.zones.find((s) => s.id === v.zoneId)!.slot, polygon: v.polygon as Vertex[] })) };
}
