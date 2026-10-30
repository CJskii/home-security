import { createHash } from 'node:crypto';
import { z } from 'zod';
import { originalJpeg } from './jpeg.js';
import { pictureReferenceSchema } from './client-schemas.js';
import { UniviewClientError, type HistoricalPictureReference, type SmartSearchEntry, type SmartSearchQuery, type UniviewClient } from './snapshot-client.js';

export const RESOLUTION_LIMITS = { snapshots: 64, notifications: 32, searches: 8, candidates: 32, downloads: 32, bytes: 64_000_000, timeoutMs: 60_000, windowSeconds: 2 } as const;
export const referenceStatuses = ['UNRESOLVED', 'VERIFIED', 'TEMPORARILY_UNAVAILABLE', 'NOT_FOUND', 'INTEGRITY_MISMATCH'] as const;
export type ReferenceStatus = typeof referenceStatuses[number];
export const referenceProvenanceSchema = z.object({
  version: z.literal(1), method: z.literal('smart_object_search_sha256'), originalSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceTime: z.iso.datetime(), timeBasis: z.enum(['snapshot_capture', 'notification_reported']),
  queryBegin: z.number().int().nonnegative(), queryEnd: z.number().int().nonnegative(), queryObjectType: z.number().int().nullable(),
  candidateTime: z.number().int().nonnegative(), sceneSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
}).strict();
export type ReferenceProvenance = z.infer<typeof referenceProvenanceSchema>;
export interface ResolutionSnapshot {
  id: string; eventId: string; notificationId: string | null; origin: string; status: string; imageType: string | null;
  sha256: string | null; sourceImageIndex: number | null; capturedAt: Date | null;
  nvrPictureName: string | null; nvrPictureSize: number | null; nvrPictureType: number | null;
  nvrRecordId: string | null; referenceVersion: number; referenceStatus?: string; referenceResolvedAt: Date | null;
}
export interface ResolutionNotification { id: string; eventId: string; reportedAt: Date | null; metadata: unknown }
export interface ResolutionEvent {
  id: string; sourceInstallationId: string; nvrChannel: number; alarmType: string;
  snapshots: ResolutionSnapshot[]; notifications: ResolutionNotification[];
}
export interface VerifiedReference { picture: HistoricalPictureReference; recordId: string | null; provenance: ReferenceProvenance }
export interface ResolutionUpdate {
  status: ReferenceStatus; reason: string | null; checkedAt: Date; reference?: VerifiedReference;
}
export interface HistoricalImageStore {
  load(eventId: string): Promise<ResolutionEvent | null>;
  save(installationId: string, snapshot: ResolutionSnapshot, update: ResolutionUpdate): Promise<boolean>;
}
export interface SnapshotResolution { snapshotId: string; status: ReferenceStatus; reason: string | null; persisted: boolean }
export class ImageResolutionError extends Error {
  constructor(readonly code: 'invalid_request' | 'event_not_found' | 'installation_mismatch' | 'event_limit' | 'busy' | 'resolution_limit') { super(`Image resolution ${code}`); }
}
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function list(value: unknown): Record<string, unknown>[] { return Array.isArray(value) ? value.map(object) : []; }
function associatedObjects(notification: ResolutionNotification, snapshot: ResolutionSnapshot) {
  const info = object(object(object(notification.metadata).StructureInfo).ObjInfo);
  const groups = [ ['PersonInfoList', 'PersonNum', 2], ['VehicleInfoList', 'VehicleNum', 4], ['NonMotorVehicleInfoList', 'NonMotorVehicleNum', 3] ] as const;
  const all = groups.flatMap(([key, , type]) => list(info[key]).map((value) => ({ value, type })));
  const attached = snapshot.sourceImageIndex === null ? [] : all.filter(({ value }) => value[snapshot.imageType === '2' ? 'SmallPicAttachIndex' : 'LargePicAttachIndex'] === snapshot.sourceImageIndex);
  let classes = (attached.length ? attached : all).map((v) => v.type as number);
  if (!classes.length) classes = groups.filter(([, count]) => typeof info[count] === 'number' && Number(info[count]) > 0).map(([, , type]) => type);
  if (!classes.length) classes = list(object(object(notification.metadata).RelatedObjects).ObjectList).map((v) => v.ObjectType).filter((v): v is number => typeof v === 'number' && [2, 3, 4].includes(v));
  return { classes: [...new Set(classes)], attached };
}
interface Candidate { picture: HistoricalPictureReference; scene: HistoricalPictureReference | null; recordId: string | null; time: number }
function reference(Type: 1 | 2, value: unknown): HistoricalPictureReference | null {
  const p = object(value); const parsed = pictureReferenceSchema.safeParse({ Type, Name: p.Name, Size: p.Size });
  return parsed.success ? parsed.data : null;
}
function key(p: HistoricalPictureReference) { return JSON.stringify([p.Type, p.Name, p.Size]); }
function candidates(entries: SmartSearchEntry[], query: SmartSearchQuery, type: 1 | 2): Candidate[] {
  const result = new Map<string, Candidate>();
  for (const entry of entries) {
    if (entry.ChannelID !== query.ChannelID || entry.Time < query.Begin || entry.Time > query.End || entry.Type !== 2) continue;
    const objects = entry.ObjectList.filter((o) => query.ObjectType === undefined || o.ObjectInfo.ObjectType === query.ObjectType);
    if (query.ObjectType !== undefined && !objects.length) continue;
    const scene = reference(1, entry.FullPicture);
    const pictures = type === 1 ? [scene] : objects.map((o) => reference(2, o.ObjectPicture));
    for (const picture of pictures) if (picture) {
      const candidate = { picture, scene, recordId: entry.RecordID === undefined ? null : String(entry.RecordID), time: entry.Time };
      result.set(JSON.stringify([key(picture), scene && key(scene)]), candidate);
      if (result.size > RESOLUTION_LIMITS.candidates) throw new ImageResolutionError('resolution_limit');
    }
  }
  return [...result.values()];
}
function missing(error: unknown) { return error instanceof UniviewClientError && [404, 410].includes(error.httpStatus ?? 0); }
function outcome(error: unknown): Pick<ResolutionUpdate, 'status' | 'reason'> {
  if (error instanceof ImageResolutionError || error instanceof UniviewClientError && ['limit', 'invalid_request'].includes(error.code)) return { status: 'UNRESOLVED', reason: 'resolution_limit' };
  return { status: 'TEMPORARILY_UNAVAILABLE', reason: error instanceof UniviewClientError ? `nvr_${error.code}` : 'nvr_unavailable' };
}

// Explicit internal enrichment only. Never called by ingestion/startup, and no media leaves this scope.
export function createHistoricalImageResolver(store: HistoricalImageStore, client: Pick<UniviewClient, 'searchObjects' | 'historicalPicture'>,
  installationId: string, now: () => Date = () => new Date()) {
  if (!z.uuid().safeParse(installationId).success) throw new ImageResolutionError('invalid_request');
  let active = false;
  return {
    async resolveEvent(eventId: string, options: { persist?: boolean; signal?: AbortSignal; snapshotId?: string; onVerified?: (snapshotId: string, picture: HistoricalPictureReference) => void } = {}) {
      if (!z.uuid().safeParse(eventId).success || options.snapshotId !== undefined && !z.uuid().safeParse(options.snapshotId).success) throw new ImageResolutionError('invalid_request');
      if (active) throw new ImageResolutionError('busy');
      active = true;
      try {
        const event = await store.load(eventId);
        if (!event) throw new ImageResolutionError('event_not_found');
        if (event.id !== eventId || event.snapshots.some((s) => s.eventId !== eventId)) throw new ImageResolutionError('invalid_request');
        if (event.sourceInstallationId !== installationId) throw new ImageResolutionError('installation_mismatch');
        if (event.snapshots.length > RESOLUTION_LIMITS.snapshots || event.notifications.length > RESOLUTION_LIMITS.notifications) throw new ImageResolutionError('event_limit');
        const signal = AbortSignal.any([AbortSignal.timeout(RESOLUTION_LIMITS.timeoutMs), ...(options.signal ? [options.signal] : [])]);
        const searchCache = new Map<string, Promise<Record<1 | 2, Candidate[]>>>(), digestCache = new Map<string, Promise<string>>();
        let searches = 0, downloads = 0, bytes = 0;
        async function digest(picture: HistoricalPictureReference): Promise<string> {
          const cacheKey = key(picture); let pending = digestCache.get(cacheKey);
          if (!pending) {
            if (signal.aborted) throw new UniviewClientError('aborted');
            if (downloads >= RESOLUTION_LIMITS.downloads) throw new ImageResolutionError('resolution_limit');
            downloads++;
            pending = (async () => {
              const jpeg = originalJpeg(await client.historicalPicture(picture, signal));
              bytes += jpeg.length;
              if (bytes > RESOLUTION_LIMITS.bytes) throw new ImageResolutionError('resolution_limit');
              return createHash('sha256').update(jpeg).digest('hex');
            })();
            digestCache.set(cacheKey, pending);
          }
          return pending;
        }
        async function discover(query: SmartSearchQuery, type: 1 | 2): Promise<Candidate[]> {
          const cacheKey = JSON.stringify(query); let pending = searchCache.get(cacheKey);
          if (!pending) {
            if (signal.aborted) throw new UniviewClientError('aborted');
            if (searches >= RESOLUTION_LIMITS.searches) throw new ImageResolutionError('resolution_limit');
            searches++;
            pending = client.searchObjects(query, signal).then((entries) => ({ 1: candidates(entries, query, 1), 2: candidates(entries, query, 2) }));
            searchCache.set(cacheKey, pending);
          }
          return (await pending)[type];
        }
        async function resolve(snapshot: ResolutionSnapshot): Promise<Omit<ResolutionUpdate, 'checkedAt'>> {
          if (snapshot.eventId !== eventId || snapshot.origin !== 'NVR_PUSH' || !['1', '2'].includes(snapshot.imageType ?? '')) return { status: 'UNRESOLVED', reason: 'unsupported_snapshot' };
          if (snapshot.status !== 'RECEIVED' || !snapshot.sha256 || !/^[a-f0-9]{64}$/.test(snapshot.sha256)) return { status: 'UNRESOLVED', reason: 'missing_original_hash' };
          const notification = event!.notifications.find((n) => n.id === snapshot.notificationId && n.eventId === eventId);
          if (!notification) return { status: 'UNRESOLVED', reason: 'missing_notification' };
          const type = Number(snapshot.imageType) as 1 | 2;
          const stored = reference(type, { Name: snapshot.nvrPictureName, Size: snapshot.nvrPictureSize });
          let mismatch = false;
          if (stored && snapshot.nvrPictureType === type && snapshot.referenceResolvedAt) {
            try { if (await digest(stored) === snapshot.sha256) { options.onVerified?.(snapshot.id, stored); return { status: 'VERIFIED', reason: null }; } mismatch = true; }
            catch (error) { if (!missing(error)) return outcome(error); }
          }
          if (event!.alarmType !== 'EnterArea') return { status: 'UNRESOLVED', reason: 'unsupported_alarm_type' };
          const time = snapshot.capturedAt ?? notification.reportedAt;
          if (!time || !Number.isFinite(time.getTime())) return { status: 'UNRESOLVED', reason: 'missing_source_time' };
          const sourceTime = Math.floor(time.getTime() / 1000);
          const { classes, attached } = associatedObjects(notification, snapshot);
          const largeIndices = attached.map((a) => a.value.LargePicAttachIndex).filter((v): v is number => typeof v === 'number');
          const sceneHashes = new Set(event!.snapshots.filter((s) => s.notificationId === notification.id && s.eventId === eventId && s.imageType === '1' && s.origin === 'NVR_PUSH' && s.status === 'RECEIVED' && s.sha256 && (largeIndices.length === 0 || (s.sourceImageIndex !== null && largeIndices.includes(s.sourceImageIndex)))).map((s) => s.sha256!));
          let unavailable: unknown, limited = false;
          for (const objectType of classes.length ? classes : [undefined]) {
            const query: SmartSearchQuery = { ChannelID: event!.nvrChannel, Begin: Math.max(0, sourceTime - RESOLUTION_LIMITS.windowSeconds), End: sourceTime + RESOLUTION_LIMITS.windowSeconds,
              AlarmType: event!.alarmType, ...(objectType === undefined ? {} : { ObjectType: objectType }) };
            let found: Candidate[];
            try { found = await discover(query, type); }
            catch (error) { const failure = outcome(error); if (failure.status === 'UNRESOLVED') limited = true; else unavailable = error; continue; }
            for (const candidate of found) {
              try {
                if (await digest(candidate.picture) !== snapshot.sha256) { mismatch = true; continue; }
                let sceneSha256: string | null = null;
                if (type === 2 && sceneHashes.size && candidate.scene) {
                  try { sceneSha256 = await digest(candidate.scene); }
                  catch (error) { if (!missing(error)) { unavailable = error; continue; } }
                  if (sceneSha256 !== null && !sceneHashes.has(sceneSha256)) { mismatch = true; continue; }
                }
                options.onVerified?.(snapshot.id, candidate.picture);
                return { status: 'VERIFIED', reason: null, reference: { picture: candidate.picture, recordId: candidate.recordId,
                  provenance: { version: 1, method: 'smart_object_search_sha256', originalSha256: snapshot.sha256,
                    sourceTime: time.toISOString(), timeBasis: snapshot.capturedAt ? 'snapshot_capture' : 'notification_reported',
                    queryBegin: query.Begin, queryEnd: query.End, queryObjectType: objectType ?? null, candidateTime: candidate.time, sceneSha256 } } };
              } catch (error) {
                if (missing(error)) continue;
                const failure = outcome(error); if (failure.status === 'UNRESOLVED') limited = true; else unavailable = error;
              }
            }
          }
          if (limited) return { status: 'UNRESOLVED', reason: 'resolution_limit' };
          if (unavailable) return outcome(unavailable);
          if (mismatch) return { status: 'INTEGRITY_MISMATCH', reason: 'candidate_hash_or_scene_mismatch' };
          return { status: 'NOT_FOUND', reason: stored ? 'verified_reference_not_found' : 'no_verified_candidate' };
        }
        const results: SnapshotResolution[] = [];
        const selected = options.snapshotId ? event.snapshots.filter((s) => s.id === options.snapshotId) : event.snapshots;
        if (options.snapshotId && !selected.length) throw new ImageResolutionError('invalid_request');
        for (const snapshot of selected) {
          const update = { ...await resolve(snapshot), checkedAt: now() };
          const persisted = options.persist === false ? false : await store.save(installationId, snapshot, update);
          results.push(persisted || options.persist === false ? { snapshotId: snapshot.id, status: update.status, reason: update.reason, persisted }
            : { snapshotId: snapshot.id, status: 'UNRESOLVED', reason: 'concurrent_update', persisted: false });
        }
        return { eventId, persist: options.persist !== false, searches, downloads, snapshots: results };
      } finally { active = false; }
    },
  };
}
