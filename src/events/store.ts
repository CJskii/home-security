import { annotateLocations, locationCatalog, locationsCte } from './locations.js';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import type { EventQueries } from '../database.js';
import type { HistoryQuery } from './queries.js';
export const EVENT_BOUNDS = { objects: 64, images: 64, memberships: 16 } as const;
export const zoneVersionSelect = {id:true,zoneId:true,revision:true,displayName:true,nameEffectiveAt:true,enabled:true,ruleEnabled:true,polygon:true,geometryFingerprint:true,observedAt:true,lastObservedAt:true} satisfies Prisma.UniviewZoneVersionSelect;
const version = { zone: { include: { versions: { select:zoneVersionSelect, orderBy: { revision: 'desc' as const }, take: 1 } } } };
export const imageSelect = { id: true, eventId: true, notificationId: true, origin: true, sha256: true, bytes: true, width: true, height: true, status: true,
  requestedAt: true, acquiredAt: true, imageOrdinal: true, sourceImageIndex: true, imageType: true, declaredWidth: true, declaredHeight: true, capturedAt: true, failureCode: true,
  referenceStatus: true, referenceCheckedAt: true, referenceFailureCode: true } satisfies Prisma.EventSnapshotSelect;
export const eventInclude = { analysis: {include:{objectAnalyses:true}}, processing: true,
  objects: { take: EVENT_BOUNDS.objects + 1, orderBy: { id: 'asc' }, include: {
    zoneEvidence: { include: { zoneVersion: { select: {...zoneVersionSelect,...version} } } },
    memberships: { take: EVENT_BOUNDS.memberships + 1, orderBy: { zoneVersionId: 'asc' }, include: { zoneVersion: { select: {...zoneVersionSelect,...version} } } },
  } },
  snapshots: { where: { origin: 'NVR_PUSH', imageType: { in: ['1', '2'] } }, take: EVENT_BOUNDS.images + 1, orderBy: { id: 'asc' }, select: imageSelect },
} satisfies Prisma.SecurityEventInclude;
interface Summary { id: string; eventTime: Date; timestampSource: string; sourceNotificationId: string | null; categories: string[] }
// Earliest Structure report is an explicit fallback, never an invented Alarm time.
export const summarySql = Prisma.sql`SELECT e.id, COALESCE(e."occurredAt",s."reportedAt",e."firstReceivedAt") AS "eventTime",
  CASE WHEN e."occurredAt" IS NOT NULL THEN 'ALARM_REPORTED_AT' WHEN s."reportedAt" IS NOT NULL THEN 'STRUCTURE_REPORTED_AT' ELSE 'FIRST_RECEIVED_AT' END AS "timestampSource",
  CASE WHEN e."occurredAt" IS NULL THEN s.id ELSE NULL END AS "sourceNotificationId",
  ARRAY(SELECT DISTINCT o.category FROM "UniviewObject" o WHERE o."eventId"=e.id ORDER BY o.category) AS categories
  FROM "SecurityEvent" e LEFT JOIN LATERAL (SELECT n.id,n."reportedAt" FROM "UniviewNotification" n
    WHERE n."eventId"=e.id AND n.kind='STRUCTURE'::"NotificationKind" AND n."reportedAt" IS NOT NULL ORDER BY n."reportedAt",n.id LIMIT 1) s ON true`;
export const eventTime = Prisma.sql`COALESCE(e."occurredAt",s."reportedAt",e."firstReceivedAt")`;
const excludedAi = ['zone_not_selected','ai_disabled','sampling_disabled'];
const capacityAi = ['capacity_exceeded','eligibility_buffer_limit','ai_capacity','ai_queue_timeout','ai_memory_limit','memory_limit'];
// One initial intent per event; optional AI updates never replace its delivery outcome.
export const notificationOutcomeSql=Prisma.sql`CASE
 WHEN ni.state='DELIVERED' THEN 'accepted'
 WHEN ni.state='UNCERTAIN' THEN 'uncertain'
 WHEN ni.state IN ('FAILED','EXPIRED','CANCELLED') THEN 'failed'
 WHEN ni.id IS NOT NULL THEN 'pending'
 WHEN ne.id IS NULL THEN 'not_evaluated'
 WHEN ne.result->>'deliveryHeldReason' IS NOT NULL THEN 'held'
 WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(ne.result->'decisions')='array' THEN ne.result->'decisions' ELSE '[]'::jsonb END) d WHERE d->>'reason' IN ('cooldown_after_delivery','cooldown_active') OR d->>'outcome'='cooldown') THEN 'cooldown'
 WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(ne.result->'decisions')='array' THEN ne.result->'decisions' ELSE '[]'::jsonb END) d WHERE d->>'reason' IN ('unknown_excluded','ambiguous_excluded')) THEN 'uncertain'
 WHEN ne.state IN ('PENDING','WAITING') THEN 'pending'
 ELSE 'excluded' END`;
export function historyFilters(q: HistoryQuery): Prisma.Sql[] {
  const clauses: Prisma.Sql[] = [];
  if (q.camera) clauses.push(Prisma.sql`e.camera=${q.camera}`);
  if (q.alarmType) clauses.push(Prisma.sql`e."alarmType"=${q.alarmType}`);
  if (q.nvrChannel) clauses.push(Prisma.sql`e."nvrChannel"=${q.nvrChannel}`);
  if (q.sourceInstallationId) clauses.push(Prisma.sql`e."sourceInstallationId"=${q.sourceInstallationId}::uuid`);
  if (q.alarmSeen !== undefined) clauses.push(Prisma.sql`e."alarmSeen"=${q.alarmSeen}`);
  if (q.activityLabel) clauses.push(Prisma.sql`EXISTS (SELECT 1 FROM "EventAnalysis" a WHERE a."eventId"=e.id AND a."activityLabel"=${q.activityLabel})`);
  if (q.occurredAfter) clauses.push(Prisma.sql`${eventTime}>=${q.occurredAfter}`);
  if (q.occurredBefore) clauses.push(Prisma.sql`${eventTime}<=${q.occurredBefore}`);
  if (q.cursor) clauses.push(q.sort==='oldest'?Prisma.sql`(${eventTime},e.id)>(${q.cursor.eventTime},${q.cursor.id}::uuid)`:Prisma.sql`(${eventTime},e.id)<(${q.cursor.eventTime},${q.cursor.id}::uuid)`);
  if(q.aiOutcome){
    if(q.aiOutcome==='completed')clauses.push(Prisma.sql`EXISTS(SELECT 1 FROM "EventAnalysis" a WHERE a."eventId"=e.id)`);
    else if(q.aiOutcome==='pending')clauses.push(Prisma.sql`NOT EXISTS(SELECT 1 FROM "EventAnalysis" a WHERE a."eventId"=e.id) AND NOT EXISTS(SELECT 1 FROM "EvidenceProcessing" p WHERE p."eventId"=e.id AND p.status NOT IN ('COLLECTING','ANALYSING'))`);
    else if(q.aiOutcome==='failed')clauses.push(Prisma.sql`EXISTS(SELECT 1 FROM "EvidenceProcessing" p WHERE p."eventId"=e.id AND p.status IN ('FAILED','INTERRUPTED'))`);
    else {const reasons=q.aiOutcome==='excluded'?excludedAi:capacityAi;
      clauses.push(Prisma.sql`EXISTS(SELECT 1 FROM "EvidenceProcessing" p WHERE p."eventId"=e.id AND ${q.aiOutcome==='excluded'?Prisma.sql`p.status IN ('SKIPPED','COMPLETE')`:Prisma.sql`p.status='SKIPPED'`} AND ${q.aiOutcome==='other_skipped'?Prisma.sql`(p.reason IS NULL OR p.reason NOT IN (${Prisma.join([...excludedAi,...capacityAi])}))`:Prisma.sql`p.reason IN (${Prisma.join(reasons)})`})`);
    }
  }
  if(q.notificationOutcome)clauses.push(Prisma.sql`EXISTS(SELECT 1 FROM (SELECT 1) anchor
    LEFT JOIN "NotificationEvaluation" ne ON ne."eventId"=e.id AND ne."sourceInstallationId"=e."sourceInstallationId" AND ne.kind='LIVE'
    LEFT JOIN "NotificationIntent" ni ON ni."eventId"=e.id AND ni.mode='LIVE'
    WHERE ${notificationOutcomeSql}=${q.notificationOutcome})`);
  const hasLocation=Boolean(q.locationZoneId || q.interestedZonesOnly || q.zoneInterest || q.locationStatus);
  if (q.vehicleGroup || q.action || q.verification || q.category || q.zoneId || q.zoneVersionId || q.zoneName || hasLocation) {
    const objects: Prisma.Sql[] = [Prisma.sql`o."eventId"=e.id`];
    if (q.category) objects.push(Prisma.sql`o.category=${q.category.toUpperCase()}`);
    if (q.vehicleGroup) {
      const types = q.vehicleGroup === 'car' ? ['car','suv'] : [q.vehicleGroup];
      objects.push(Prisma.sql`o.category IN ('MOTOR_VEHICLE','NON_MOTOR_VEHICLE') AND EXISTS (
        SELECT 1 FROM "ObjectAnalysis" ai JOIN "EventAnalysis" ea ON ea."eventId"=ai."eventId"
        CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(ea.subjects)='array' THEN ea.subjects ELSE '[]'::jsonb END) subject
        WHERE ai."objectId"=o.id AND ai."eventId"=o."eventId" AND ai.verification<>'contradicted'
          AND ai."observedType" IN ('motor_vehicle','non_motor_vehicle')
          AND subject->>'objectId'=o.id::text AND subject->>'type'='vehicle'
          AND subject->'vehicle'->>'vehicleType' IN (${Prisma.join(types)})
      )`);
    }
    if(q.action || q.verification){
      const ai=[Prisma.sql`a."objectId"=o.id`];
      if(q.verification)ai.push(Prisma.sql`a.verification=${q.verification}`);
      if(q.action)ai.push(Prisma.sql`a.actions @> ${JSON.stringify([q.action])}::jsonb`);
      objects.push(Prisma.sql`EXISTS (SELECT 1 FROM "ObjectAnalysis" a WHERE ${Prisma.join(ai,' AND ')})`);
    }
    if (q.zoneId || q.zoneVersionId || q.zoneName) {
      const zones = [Prisma.sql`z."sourceInstallationId"=e."sourceInstallationId"`, Prisma.sql`z.channel=e."nvrChannel"`];
      if (q.zoneId) zones.push(Prisma.sql`z.id=${q.zoneId}::uuid`);
      if (q.zoneVersionId) zones.push(Prisma.sql`v.id=${q.zoneVersionId}::uuid`);
      if (q.zoneName) zones.push(q.zoneNameScope === 'current' ? Prisma.sql`z."displayName"=${q.zoneName}` : Prisma.sql`v."displayName"=${q.zoneName}`);
      objects.push(q.zoneRelation === 'trigger' ? Prisma.sql`EXISTS (SELECT 1 FROM "ObjectZoneEvidence" a JOIN "UniviewZoneVersion" v ON v.id=a."zoneVersionId" JOIN "UniviewZone" z ON z.id=v."zoneId"
        WHERE a."objectId"=o.id AND a.status='CONFIRMED_GEOMETRY_MATCH' AND ${Prisma.join(zones, ' AND ')})`
        : Prisma.sql`EXISTS (SELECT 1 FROM "ObjectZoneMembership" m JOIN "UniviewZoneVersion" v ON v.id=m."zoneVersionId" JOIN "UniviewZone" z ON z.id=v."zoneId"
        WHERE m."objectId"=o.id AND m.relationship IN ('WITHIN','INTERSECTS') AND ${Prisma.join(zones, ' AND ')})`);
    }
    if(hasLocation){
      const conditions=[Prisma.sql`l.id=o.id`];
      if(q.locationZoneId)conditions.push(Prisma.sql`l.status='MATCHED' AND ${q.locationZoneId}=ANY(l.zones)`);
      if(q.zoneInterest==='interested')conditions.push(Prisma.sql`l.status='MATCHED' AND l.interested`);
      if(q.zoneInterest==='other')conditions.push(Prisma.sql`l.status='MATCHED' AND NOT COALESCE(l.interested,false)`);
      if(q.interestedZonesOnly)conditions.push(Prisma.sql`l.status='MATCHED' AND l.interested`);
      if(q.locationStatus)conditions.push(q.locationStatus==='uncertain'?Prisma.sql`l.status IN ('UNKNOWN','AMBIGUOUS')`:Prisma.sql`l.status=${q.locationStatus.toUpperCase()}`);
      objects.push(Prisma.sql`EXISTS(SELECT 1 FROM object_locations l WHERE ${Prisma.join(conditions,' AND ')})`);
    }
    const exists=Prisma.sql`EXISTS (SELECT 1 FROM "UniviewObject" o WHERE ${Prisma.join(objects, ' AND ')})`;
    const sourceOnly=!q.category&&!q.vehicleGroup&&!q.action&&!q.verification&&!q.zoneId&&!q.zoneVersionId&&!q.zoneName;
    clauses.push(sourceOnly&&!q.locationZoneId&&!q.interestedZonesOnly&&['unknown','uncertain'].includes(q.locationStatus??'')?Prisma.sql`(${exists} OR NOT EXISTS(SELECT 1 FROM "UniviewObject" lo WHERE lo."eventId"=e.id))`:exists);
  }

  if(q.zoneInterest==='other')clauses.push(Prisma.sql`NOT EXISTS (SELECT 1 FROM object_locations own WHERE own."eventId"=e.id AND own.status='MATCHED' AND own.interested)`);
  return clauses;
}
export function createEventQueries(prisma: PrismaClient): EventQueries {
  return {
    async history(query) {
      const catalog=await locationCatalog(prisma);
      const prefix=query.locationZoneId || query.interestedZonesOnly || query.zoneInterest || query.locationStatus ? locationsCte(catalog):Prisma.empty;
      const filters = historyFilters(query);
      const summaries = await prisma.$queryRaw<Summary[]>(Prisma.sql`${prefix} ${summarySql} ${filters.length ? Prisma.sql`WHERE ${Prisma.join(filters, ' AND ')}` : Prisma.empty}
        ORDER BY ${eventTime} ${query.sort==='oldest'?Prisma.sql`ASC`:Prisma.sql`DESC`},e.id ${query.sort==='oldest'?Prisma.sql`ASC`:Prisma.sql`DESC`} LIMIT ${query.limit + 1}`);
      const rows = await prisma.securityEvent.findMany({ where: { id: { in: summaries.map((r) => r.id) } }, include: eventInclude });
      const found = new Map(rows.map((r) => [r.id,r]));
      return summaries.flatMap((s) => { const row = found.get(s.id); return row ? [{ ...annotateLocations(row,catalog), ...s }] : []; });
    },
    async get(id) {
      const [summary] = await prisma.$queryRaw<Summary[]>(Prisma.sql`${summarySql} WHERE e.id=${id}::uuid`);
      if (!summary) return null;
      const row = await prisma.securityEvent.findUnique({ where: { id }, include: eventInclude });
      return row ? { ...annotateLocations(row,await locationCatalog(prisma)), ...summary } : null;
    },
    notifications: (eventId, limit, before) => prisma.univiewNotification.findMany({ where: { eventId,
      ...(before ? { OR: [{ receivedAt: { lt: before.receivedAt } }, { receivedAt: before.receivedAt, id: { lt: before.id } }] } : {}) },
      select: { id: true, eventId: true, kind: true, contentHash: true, reportedAt: true, receivedAt: true, personCount: true, vehicleCount: true, objectType: true, schemaVersion: true },
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }], take: limit + 1 }),
    snapshots: (eventId, limit, after) => prisma.eventSnapshot.findMany({ where: { eventId, ...(after ? { id: { gt: after } } : {}) }, select: imageSelect, orderBy: { id: 'asc' }, take: limit + 1 }),
  };
}
