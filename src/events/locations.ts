import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import { usablePolygon, type Vertex } from '../uniview/zone-geometry.js';
import { locateObject, type LocationZone } from '../uniview/object-location.js';

// Read-only projection: source versions, notification-local object UUIDs and image
// anchors remain untouched. The catalog is small, not a list of event IDs.
export async function locationCatalog(prisma: Pick<PrismaClient,'univiewZoneVersion'>, installation?:string): Promise<LocationZone[]> {
  const versions = await prisma.univiewZoneVersion.findMany({ ...(installation?{where:{zone:{sourceInstallationId:installation}}}:{}), take: 4097, include: { zone: { include: { preference: true } } } });
  if (versions.length > 4096) throw new Error('Historical zone catalog limit exceeded');
  return versions.map(v => ({ id:v.id, zoneId:v.zoneId, revision:v.revision, slot:v.zone.slot, channel:v.zone.channel,
    sourceInstallationId:v.zone.sourceInstallationId, enabled:v.enabled, ruleEnabled:v.ruleEnabled === true,
    polygon:Array.isArray(v.polygon) ? v.polygon as unknown as Vertex[] : [], observedAt:v.observedAt,
    lastObservedAt:v.lastObservedAt, nameEffectiveAt:v.nameEffectiveAt,
    name:v.zone.preference?.displayName ?? v.displayName, interested:v.zone.preference?.interested ?? false }));
}
export function annotateLocations<T extends { sourceInstallationId:string; nvrChannel:number; objects:unknown[] }>(row:T, catalog:LocationZone[]) {
  const zones=catalog.filter(z=>z.sourceInstallationId===row.sourceInstallationId && z.channel===row.nvrChannel);
  return {...row,objects:row.objects.map(object=>{
    const o=object as Parameters<typeof locateObject>[0];
    return {...object as Record<string,unknown>,location:locateObject(o,zones,'person_ground_point')};
  })};
}
// Native PostgreSQL geometry operators support concave/multi-vertex polygons.
// Validated coordinates are bound as data; no NVR or user text becomes SQL.
export function locationsCte(catalog:LocationZone[]): Prisma.Sql {
  const data=catalog.map(z=>({id:z.id,zoneId:z.zoneId,slot:z.slot,channel:z.channel,installation:z.sourceInstallationId,
    start:new Date(Math.max(z.observedAt.getTime(),z.nameEffectiveAt.getTime())).toISOString(),end:z.lastObservedAt.toISOString(),
    active:z.enabled&&z.ruleEnabled,valid:usablePolygon(z.polygon),interested:z.interested,
    region:usablePolygon(z.polygon)?`(${z.polygon.map(p=>`(${p.X},${p.Y})`).join(',')})`:null}));
  return Prisma.sql`WITH location_catalog AS MATERIALIZED (
    SELECT * FROM jsonb_to_recordset(${JSON.stringify(data)}::jsonb) AS z(id text,"zoneId" text,slot int,channel int,installation text,start timestamptz,"end" timestamptz,active boolean,valid boolean,interested boolean,region text)
  ), object_locations AS (
    SELECT o.id,o."eventId",
      CASE WHEN o."coordinateStatus"<>'VALID' OR o."xMin" IS NULL OR o."xMax" IS NULL OR o."yMin" IS NULL OR o."yMax" IS NULL
        OR o."xMin"<0 OR o."yMin"<0 OR o."xMax">10000 OR o."yMax">10000 OR o."xMin">=o."xMax" OR o."yMin">=o."yMax"
        OR o."fullFrameSnapshotId" IS NULL OR o."sourceTimestamp" IS NULL OR count(z.id)<>4 OR count(DISTINCT z.slot)<>4 OR bool_or(z.active AND NOT z.valid) THEN 'UNKNOWN'
      WHEN o.category='PERSON' AND o."xMin">0 AND o."xMax"<10000 AND o."yMax"<10000
        AND bool_or(z.active AND z.valid AND point((o."xMin"+o."xMax")/2.0,o."yMax") <@ z.region::polygon) THEN 'MATCHED'
      WHEN bool_or(z.active AND z.valid AND ((point((o."xMin"+o."xMax")/2.0,o."yMax") <@ z.region::polygon)
         IS DISTINCT FROM (point((o."xMin"+o."xMax")/2.0,(o."yMin"+o."yMax")/2.0) <@ z.region::polygon)))
        OR bool_or(z.active AND z.valid AND (point((o."xMin"+o."xMax")/2.0,o."yMax") <-> path(z.region::polygon)<=100
          OR point((o."xMin"+o."xMax")/2.0,(o."yMin"+o."yMax")/2.0) <-> path(z.region::polygon)<=100))
        OR o."xMin"=0 OR o."xMax"=10000 OR o."yMax"=10000 THEN 'AMBIGUOUS'
      WHEN bool_or(z.active AND z.valid AND point((o."xMin"+o."xMax")/2.0,o."yMax") <@ z.region::polygon) THEN 'MATCHED' ELSE 'UNMATCHED' END AS status,
      array_agg(z."zoneId") FILTER(WHERE z.active AND z.valid AND point((o."xMin"+o."xMax")/2.0,o."yMax") <@ z.region::polygon) AS zones,
      bool_or(z.active AND z.valid AND z.interested AND point((o."xMin"+o."xMax")/2.0,o."yMax") <@ z.region::polygon) AS interested
    FROM "UniviewObject" o JOIN "SecurityEvent" le ON le.id=o."eventId"
    LEFT JOIN location_catalog z ON z.installation=le."sourceInstallationId"::text AND z.channel=le."nvrChannel"
      AND o."sourceTimestamp">=z.start AND o."sourceTimestamp"<=z."end"
    GROUP BY o.id
  )`;
}
