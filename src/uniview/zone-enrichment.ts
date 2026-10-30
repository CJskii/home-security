import { z } from 'zod';
import type { UniviewClient, SmartSearchEntry, SmartSearchQuery } from './snapshot-client.js';
import { mediaFreeMetadata } from './schemas.js';
import { observedAtTime, triggeringMatch, type ZoneVersion } from './zones.js';
import { polygonSchema, rectangleMembership, usablePolygon, type Rectangle, type Vertex } from './zone-geometry.js';
export const ZONE_ENRICHMENT_LIMITS = { objects: 64, versions: 256, searches: 8, candidates: 32, timeoutMs: 60000 } as const;
interface ImageReference {
  id: string; origin: string; status: string; imageType: string | null; referenceStatus: string;
  nvrPictureName: string | null; nvrPictureSize: number | null; sha256: string | null;
}
export interface ZoneObject {
  id: string; category: string; sourceTimestamp: Date | null; coordinateStatus: string;
  xMin: number | null; yMin: number | null; xMax: number | null; yMax: number | null;
  fullFrameSnapshot: ImageReference | null; cropSnapshot: ImageReference | null;
  zoneEvidence: { status: string; reason: string; zoneVersionId: string | null; sourceRules: unknown } | null;
}
interface ZoneEvent { id: string; sourceInstallationId: string; nvrChannel: number; alarmType: string; objects: ZoneObject[] }
export interface ZoneEvidenceWrite {
  objectId: string; status: 'CONFIRMED_GEOMETRY_MATCH' | 'AMBIGUOUS' | 'UNKNOWN'; reason: string; zoneVersionId: string | null;
  sourceRules: Record<string, unknown>[]; provenance: Record<string, unknown>; enrichedAt: Date;
  memberships: { zoneVersionId: string; relationship: 'WITHIN' | 'INTERSECTS' | 'OUTSIDE' }[];
}
export interface ZoneEnrichmentStore {
  load(id: string): Promise<ZoneEvent | null>;
  versions(installationId: string, channel: number, begin: Date, end: Date): Promise<ZoneVersion[]>;
  save(installationId: string, eventId: string, write: ZoneEvidenceWrite): Promise<boolean>;
}
export class ZoneEnrichmentError extends Error {
  constructor(readonly code: 'invalid_request' | 'event_not_found' | 'installation_mismatch' | 'limit' | 'busy' | 'nvr_unavailable') { super(`Zone enrichment ${code}`); }
}
const categoryCode = (category: string) => category === 'PERSON' ? 2 : category === 'MOTOR_VEHICLE' ? 4 : category === 'NON_MOTOR_VEHICLE' ? 3 : undefined;
function rectangle(object: ZoneObject): Rectangle | null {
  if (!object.fullFrameSnapshot || object.fullFrameSnapshot.origin !== 'NVR_PUSH' || object.fullFrameSnapshot.imageType !== '1'
    || object.coordinateStatus !== 'VALID' || object.xMin === null || object.yMin === null || object.xMax === null || object.yMax === null) return null;
  return { xMin: object.xMin, yMin: object.yMin, xMax: object.xMax, yMax: object.yMax };
}
function verified(image: ImageReference | null, type: string) {
  return image?.origin === 'NVR_PUSH' && image.status === 'RECEIVED' && image.imageType === type && image.referenceStatus === 'VERIFIED'
    && image.nvrPictureName !== null && image.nvrPictureSize !== null && image.sha256 !== null;
}
function samePicture(image: ImageReference | null, type: string, picture: { Name: string; Size: number }) {
  return verified(image, type) && image!.nvrPictureName === picture.Name && image!.nvrPictureSize === picture.Size;
}
function rulePolygon(value: unknown): Vertex[] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const rule = value as Record<string, unknown>;
  if ((typeof rule.PointNum !== 'number' || rule.PointNum < 3 || rule.PointNum > 16) || !Array.isArray(rule.PointList) || rule.PointNum !== rule.PointList.length) return null;
  const parsed = polygonSchema.safeParse(rule.PointList.map((p: unknown) => {
    const point = p && typeof p === 'object' ? p as Record<string, unknown> : {};
    return { X: point.X, Y: point.Y };
  }));
  return parsed.success && usablePolygon(parsed.data) ? parsed.data : null;
}
function savedCandidates(object: ZoneObject) {
  const rules = object.zoneEvidence?.sourceRules;
  return Array.isArray(rules) ? rules.filter((v): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v))
    .map((evidence) => ({ evidence, polygon: rulePolygon(evidence.rule) })) : [];
}
function sourceCandidates(entries: SmartSearchEntry[], query: SmartSearchQuery, object: ZoneObject) {
  const rect = rectangle(object);
  const position = rect ? `${rect.xMin},${rect.yMin};${rect.xMax},${rect.yMax}` : null;
  const found = new Map<string, { evidence: Record<string, unknown>; polygon: Vertex[] | null }>();
  for (const entry of entries) {
    if (entry.ChannelID !== query.ChannelID || entry.Type !== 2 || entry.Time < query.Begin || entry.Time > query.End) continue;
    for (const candidate of entry.ObjectList) {
      if (query.ObjectType === undefined || candidate.ObjectInfo.ObjectType !== query.ObjectType) continue;
      const info = query.ObjectType === 2 ? candidate.ObjectInfo.PersonInfo : query.ObjectType === 4 ? candidate.ObjectInfo.VehicleInfo : candidate.ObjectInfo.NonMotorVehicleInfo;
      const cropMatch = samePicture(object.cropSnapshot, '2', candidate.ObjectPicture);
      const sceneMatch = samePicture(object.fullFrameSnapshot, '1', entry.FullPicture);
      // Match evidence images, never Alarm/Structure IDs to Smart Search ObjectID.
      if (!cropMatch && !(sceneMatch && position !== null && info?.Position === position)) continue;
      // A conflicting verified scene is evidence against a crop candidate.
      if (verified(object.fullFrameSnapshot, '1') && !sceneMatch) continue;
      const rule = info?.RuleInfo;
      const polygon = rulePolygon(rule);
      const evidence = mediaFreeMetadata({ rule: rule ?? null, recordId: entry.RecordID === undefined ? null : String(entry.RecordID),
        smartObjectId: String(candidate.ObjectID), sourceObjectType: candidate.ObjectInfo.ObjectType,
        candidateTime: entry.Time, position: info?.Position ?? null,
        imageMatch: cropMatch ? 'VERIFIED_CROP_REFERENCE' : 'VERIFIED_SCENE_RECTANGLE' });
      found.set(JSON.stringify(evidence), { evidence, polygon });
      if (found.size > ZONE_ENRICHMENT_LIMITS.candidates) throw new ZoneEnrichmentError('limit');
    }
  }
  return [...found.values()];
}
// Keep only search reference/rule metadata between objects in this invocation.
// Smart Search picture.Data/URLs and unrelated object attributes are not retained.
function searchMetadata(entries: SmartSearchEntry[]): SmartSearchEntry[] {
  const info = (value: SmartSearchEntry['ObjectList'][number]['ObjectInfo']['PersonInfo']) => value ? {
    ...(value.Position === undefined ? {} : { Position: value.Position }),
    ...(value.RuleInfo === undefined ? {} : { RuleInfo: mediaFreeMetadata(value.RuleInfo) as typeof value.RuleInfo }),
  } : undefined;
  return entries.map((entry) => ({ Type: entry.Type, ChannelID: entry.ChannelID, Time: entry.Time,
    ...(entry.RecordID === undefined ? {} : { RecordID: entry.RecordID }), FullPicture: { Name: entry.FullPicture.Name, Size: entry.FullPicture.Size },
    ObjectList: entry.ObjectList.map((object) => {
      const person = info(object.ObjectInfo.PersonInfo), vehicle = info(object.ObjectInfo.VehicleInfo), nonmotor = info(object.ObjectInfo.NonMotorVehicleInfo);
      return { ObjectID: object.ObjectID, ObjectPicture: { Name: object.ObjectPicture.Name, Size: object.ObjectPicture.Size },
        ObjectInfo: { ObjectType: object.ObjectInfo.ObjectType, ...(person ? { PersonInfo: person } : {}),
          ...(vehicle ? { VehicleInfo: vehicle } : {}), ...(nonmotor ? { NonMotorVehicleInfo: nonmotor } : {}) } };
    }),
  }));
}
export function createZoneEnricher(store: ZoneEnrichmentStore, client: Pick<UniviewClient, 'searchObjects'>,
  installationId: string, now: () => Date = () => new Date()) {
  z.uuid().parse(installationId);
  let active = false;
  return { async enrichEvent(eventId: string, signal?: AbortSignal) {
    if (!z.uuid().safeParse(eventId).success) throw new ZoneEnrichmentError('invalid_request');
    if (active) throw new ZoneEnrichmentError('busy');
    active = true;
    try {
      const event = await store.load(eventId);
      if (!event) throw new ZoneEnrichmentError('event_not_found');
      if (event.id !== eventId) throw new ZoneEnrichmentError('invalid_request');
      if (event.sourceInstallationId !== installationId) throw new ZoneEnrichmentError('installation_mismatch');
      if (event.objects.length > ZONE_ENRICHMENT_LIMITS.objects) throw new ZoneEnrichmentError('limit');
      const retryable = (o: ZoneObject) => !o.zoneEvidence || o.zoneEvidence.status === 'UNKNOWN';
      const pending = event.objects.filter(retryable);
      const times = pending.flatMap((o) => o.sourceTimestamp ? [o.sourceTimestamp.getTime()] : []);
      const versions = times.length ? await store.versions(installationId, event.nvrChannel, new Date(Math.min(...times)), new Date(Math.max(...times))) : [];
      if (versions.length > ZONE_ENRICHMENT_LIMITS.versions) throw new ZoneEnrichmentError('limit');
      const deadline = AbortSignal.any([AbortSignal.timeout(ZONE_ENRICHMENT_LIMITS.timeoutMs), ...(signal ? [signal] : [])]);
      const cache = new Map<string, SmartSearchEntry[]>();
      const candidates = new Map<string, ReturnType<typeof sourceCandidates>>();
      // Fetch bounded source data before writing; transient NVR errors never freeze UNKNOWN.
      for (const object of pending) {
        const saved = savedCandidates(object);
        if (saved.length) { candidates.set(object.id, saved); continue; }
        const code = categoryCode(object.category);
        if (!object.sourceTimestamp || code === undefined || event.alarmType !== 'EnterArea'
          || !verified(object.fullFrameSnapshot, '1') && !verified(object.cropSnapshot, '2')) continue;
        const seconds = Math.floor(object.sourceTimestamp.getTime() / 1000);
        const query = { ChannelID: event.nvrChannel, Begin: Math.max(0, seconds - 2), End: seconds + 2, AlarmType: event.alarmType, ObjectType: code };
        const key = JSON.stringify(query);
        if (!cache.has(key)) {
          if (cache.size >= ZONE_ENRICHMENT_LIMITS.searches) throw new ZoneEnrichmentError('limit');
          try { cache.set(key, searchMetadata(await client.searchObjects(query, deadline))); }
          catch { throw new ZoneEnrichmentError('nvr_unavailable'); }
        }
        candidates.set(object.id, sourceCandidates(cache.get(key)!, query, object));
      }
      const results: { objectId: string; status: string; reason: string; persisted: boolean }[] = [];
      for (const object of event.objects) {
        if (!retryable(object) && object.zoneEvidence) {
          results.push({ objectId: object.id, status: object.zoneEvidence.status, reason: object.zoneEvidence.reason, persisted: false }); continue;
        }
        const found = candidates.get(object.id) ?? [];
        const rect = rectangle(object);
        const applicable = object.sourceTimestamp ? versions.filter((v) => observedAtTime(v, object.sourceTimestamp!)) : [];
        const memberships = rect ? applicable.filter((v) => usablePolygon(v.polygon)).map((v) => ({ zoneVersionId: v.id, relationship: rectangleMembership(rect, v.polygon) })) : [];
        const match = found.length === 1 && object.sourceTimestamp ? triggeringMatch(found[0]!.polygon, versions, object.sourceTimestamp)
          : { status: found.length > 1 ? 'AMBIGUOUS' as const : 'UNKNOWN' as const, zoneVersionId: null,
            reason: found.length > 1 ? 'multiple_source_objects' : 'no_verified_source_rule' };
        if (Buffer.byteLength(JSON.stringify(found.map((v) => v.evidence))) > 262144) throw new ZoneEnrichmentError('limit');
        const write: ZoneEvidenceWrite = { objectId: object.id, ...match, sourceRules: found.map((v) => v.evidence), memberships, enrichedAt: now(),
          provenance: { version: 1, method: 'verified_image_reference_smart_search',
            fullFrameSha256: object.fullFrameSnapshot?.sha256 ?? null, cropSha256: object.cropSnapshot?.sha256 ?? null,
            sourceTimestamp: object.sourceTimestamp?.toISOString() ?? null,
            temporalBasis: 'observation_bracket_not_actual_change_time', membershipBasis: 'original_full_frame_rectangle',
            applicableVersionIds: applicable.map((v) => v.id) } };
        // Retained source rules are reused; only UNKNOWN may gain later corroboration.
        const persisted = await store.save(installationId, eventId, write);
        results.push({ objectId: object.id, status: match.status, reason: match.reason, persisted });
      }
      return results;
    } finally { active = false; }
  } };
}
