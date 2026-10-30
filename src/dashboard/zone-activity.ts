import { z } from 'zod';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import { locationCatalog, locationsCte } from '../events/locations.js';
import { notificationGeometry } from '../notifications/current-geometry.js';
import type { LocationZone } from '../uniview/object-location.js';

export const activityZone = z.object({ zoneId: z.uuid(), channel: z.number().int().min(1).max(2), slot: z.number().int().min(0).max(3), name: z.string().max(128), enabled: z.boolean(), versionId: z.uuid(), lastActivityAt: z.iso.datetime().nullable(), basis: z.enum(['observed_configuration_bracket','latest_confirmed_geometry_assumed_unchanged']), stale: z.boolean() }).strict();
export type ActivityZone = z.infer<typeof activityZone>;
// Latest geometry only: never reinterpret old source positions with new polygons.
// Same bounded carry-forward as live notifications, without evaluating a rule.
export function activityCatalog(versions: LocationZone[], now: Date) {
  return [1, 2].flatMap(channel => {
    const camera=versions.filter(v=>v.channel===channel);
    const extended=notificationGeometry({sourceTimestamp:now},camera,now);
    const latest=[...new Set(camera.map(v=>v.slot))].flatMap(slot=>camera.filter(v=>v.slot===slot).sort((a,b)=>b.observedAt.getTime()-a.observedAt.getTime()||b.id.localeCompare(a.id)).slice(0,1));
    // A tied source version or incomplete channel is not suitable for attribution.
    if(latest.length!==4||latest.some(v=>camera.some(other=>other.slot===v.slot&&other.id!==v.id&&other.observedAt.getTime()===v.observedAt.getTime())))return [];
    return latest.map(v=>({original:v,effective:extended.versions.find(e=>e.id===v.id)!,cached:extended.cached}));
  });
}
export function createZoneActivity(prisma: PrismaClient) {
  return async (installation: string, now=new Date()): Promise<ActivityZone[]> => {
    const selected=activityCatalog(await locationCatalog(prisma,installation),now);
    if(!selected.length)return [];
    const rows=await prisma.$queryRaw<{zoneId:string;lastActivityAt:Date}[]>(Prisma.sql`${locationsCte(selected.map(v=>v.effective))}
      SELECT c."zoneId", MAX(o."sourceTimestamp") AS "lastActivityAt"
      FROM object_locations l JOIN "UniviewObject" o ON o.id=l.id
      JOIN "SecurityEvent" e ON e.id=o."eventId"
      JOIN location_catalog c ON c."zoneId"=ANY(l.zones) AND c.channel=e."nvrChannel"
      WHERE e."sourceInstallationId"=${installation}::uuid AND l.status='MATCHED' AND c.active
        AND o."sourceTimestamp"<=${now}
      GROUP BY c."zoneId"`);
    return selected.map(({original:v,cached})=>{
      const at=rows.find(r=>r.zoneId===v.zoneId)?.lastActivityAt;
      return activityZone.parse({zoneId:v.zoneId,channel:v.channel,slot:v.slot,name:v.name,enabled:v.enabled&&v.ruleEnabled,versionId:v.id,lastActivityAt:at?.toISOString()??null,basis:cached&&at&&at>v.lastObservedAt?'latest_confirmed_geometry_assumed_unchanged':'observed_configuration_bracket',stale:now.getTime()-v.lastObservedAt.getTime()>1200000});
    }).sort((a,b)=>a.channel-b.channel||a.slot-b.slot);
  };
}
