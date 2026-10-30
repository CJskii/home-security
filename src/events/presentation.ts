import { structuredSubjectSchema } from '../ai/visual-schema.js';
import { EVENT_BOUNDS } from './store.js';
const obj = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const rows = (value: unknown) => Array.isArray(value) ? value.map(obj) : [];
const pick = (value: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key,value[key]]));
export function presentZoneVersion(value: unknown) {
  const version = obj(value), zone = obj(version.zone), current = rows(zone.versions)[0];
  return { ...pick(version,['id','revision','displayName','nameEffectiveAt','enabled','ruleEnabled','polygon','geometryFingerprint','configuration','observedAt','lastObservedAt']),
    zoneId: version.zoneId ?? zone.id, slot: zone.slot, currentName: zone.displayName,
    currentVersionId: current?.id ?? null, temporalBasis: 'observations_not_actual_change_times' };
}
export function presentImage(value: Record<string, unknown>) {
  const original = value.origin === 'NVR_PUSH' && ['1','2'].includes(String(value.imageType));
  return { ...pick(value,['id','eventId','notificationId','origin','sha256','bytes','width','height','status','capturedAt','failureCode','imageOrdinal','sourceImageIndex','declaredWidth','declaredHeight','requestedAt','acquiredAt']),
    type: original ? Number(value.imageType) : null,
    availability: { state: original ? value.referenceStatus ?? 'UNRESOLVED' : 'NOT_ORIGINAL', checkedAt: value.referenceCheckedAt ?? null, reason: value.referenceFailureCode ?? null, permanentExpiryConfirmed: false },
    url: original ? `/api/events/${value.eventId}/images/${value.id}` : null };
}
function presentObject(value: Record<string, unknown>, analyses:Record<string,unknown>[], subjects:Record<string,unknown>[]) {
  const evidence = obj(value.zoneEvidence), memberships = rows(value.memberships);
  const attributes = structuredSubjectSchema.safeParse(subjects.find(s=>s.objectId===value.id));
  const valid = value.coordinateStatus === 'VALID';
  return { ...pick(value,['id','notificationId','sourceList','sourceOrdinal','sourceIdentifiers','sourceCategoryCode','sourceSubtypeCode','classificationBasis','sourceTimestamp','timestampBasis','positionRaw','coordinateStatus']),
    analysis: analyses.find(a=>a.objectId===value.id) ? {...pick(analyses.find(a=>a.objectId===value.id)!,['observedType','verification','actions','evidenceImages','shortDescription','uncertainties']),...(attributes.success?{person:attributes.data.person,vehicle:attributes.data.vehicle,relationship:attributes.data.relationship??null,attributeEvidence:attributes.data.attributeEvidence,...(attributes.data.diagnostics?{diagnostics:attributes.data.diagnostics}:{})}:{}),authority:'ai_interpretation'} : null,
    location: value.location ?? null,
    category: typeof value.category === 'string' ? value.category.toLowerCase() : 'unknown',
    rectangle: valid ? { ...pick(value,['xMin','yMin','xMax','yMax']), scale: 10000, origin: 'top_left', imageId: value.fullFrameSnapshotId ?? null, coordinateSpace: 'original_full_frame' } : null,
    images: { fullFrameId: value.fullFrameSnapshotId ?? null, cropId: value.cropSnapshotId ?? null },
    triggeringZone: { status: evidence.status ?? 'UNKNOWN', reason: evidence.reason ?? 'not_enriched', version: evidence.zoneVersion ? presentZoneVersion(evidence.zoneVersion) : null,
      sourceRules: rows(evidence.sourceRules).slice(0,32).map((item) => ({ rule: { ...pick(obj(item.rule),['RuleType','TrigerType','PointNum']), PointList:rows(obj(item.rule).PointList).slice(0,16).map((p)=>pick(p,['X','Y'])) }, candidateTime: item.candidateTime, imageMatch: item.imageMatch })) },
    geometricMemberships: memberships.slice(0,EVENT_BOUNDS.memberships).map((m) => ({ relationship: m.relationship, version: presentZoneVersion(m.zoneVersion) })),
    membershipsTruncated: memberships.length > EVENT_BOUNDS.memberships };
}
export function presentEvent(row: Record<string, unknown>) {
  const objects = rows(row.objects), images = rows(row.snapshots);
  const analysis = obj(row.analysis);
  return { ...pick(row,['id','sourceInstallationId','nvrChannel','alarmType','relatedId','camera','alarmSeen','occurredAt','sourceUpdatedAt','nativeEndedAt','firstReceivedAt','lastReceivedAt','createdAt','updatedAt','processing']),
    source: 'UNIVIEW', authority: 'authoritative',
    timestamp: { value: row.eventTime ?? row.occurredAt ?? row.firstReceivedAt, source: row.timestampSource ?? (row.occurredAt ? 'ALARM_REPORTED_AT' : 'FIRST_RECEIVED_AT'),
      notificationId: row.sourceNotificationId ?? null, imageCaptureTime: false },
    categories: Array.isArray(row.categories) ? row.categories.map((v) => String(v).toLowerCase()) : [...new Set(objects.map((v) => String(v.category).toLowerCase()))],
    objects: objects.slice(0,EVENT_BOUNDS.objects).map(o=>presentObject(o,rows(analysis.objectAnalyses),rows(analysis.subjects))), images: images.slice(0,EVENT_BOUNDS.images).map(presentImage),
    enrichment: {endpoint:`/api/events/${row.id}/enrich`,method:'POST',automaticOnRead:false},
    truncated: { objects: objects.length > EVENT_BOUNDS.objects, images: images.length > EVENT_BOUNDS.images },
    analysis: row.analysis ? { evidence:rows(analysis.evidence).slice(0,6).map(e=>({...pick(e,['image','role','sha256','origin','width','height','sourceTimestamp','requestedAt','acquiredAt','replayRequestedAt','timeBasis','inferenceTelemetry']),preparation:pick(obj(e.preparation),['method','maxWidth','maxHeight','jpegQuality','mediaPersisted'])})), ...pick(analysis,['inputFingerprint','revision','model','promptVersion','schemaVersion','activityLabel','shortDescription','subjects','uncertainties','completedAt']), authority: 'ai_interpretation' } : null };
}
