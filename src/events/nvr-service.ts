import { createHash } from 'node:crypto';
import type { Database } from '../database.js';
import type { Config } from '../config.js';
import { createHistoricalImageResolver, ImageResolutionError, type ResolutionSnapshot } from '../uniview/historical-image-resolution.js';
import { createZoneEnricher } from '../uniview/zone-enrichment.js';
import { createUniviewClient, UniviewClientError, type UniviewClient } from '../uniview/snapshot-client.js';
import { originalJpeg } from '../uniview/jpeg.js';
export class MediaFailure extends Error {
  constructor(readonly status: number, readonly code: string, readonly availability: string) { super(code); }
}
export const MEDIA_WORK_LIMITS = { active: 2, queued: 32, consumers: 64 } as const;
export interface NvrApi {
  image(eventId: string, imageId: string, signal?: AbortSignal): Promise<Buffer>;
  enrich(eventId: string, signal?: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}
type PendingImage = { controller: AbortController; promise: Promise<Buffer>; consumers: Set<symbol> };
const reference = (s: ResolutionSnapshot) => s.nvrPictureName && s.nvrPictureSize && s.nvrPictureType === Number(s.imageType) && s.referenceResolvedAt
  ? { Type: s.nvrPictureType as 1 | 2, Name: s.nvrPictureName, Size: s.nvrPictureSize } : null;
export function createNvrApi(config: Config, database: Database, suppliedClient?: UniviewClient): NvrApi | undefined {
  if (!database.historicalImages || !config.UNIVIEW_INSTALLATION_ID || !config.UNIVIEW_NVR_IP || !config.UNIVIEW_USERNAME || !config.UNIVIEW_PASSWORD) return undefined;
  const store = database.historicalImages, installation = config.UNIVIEW_INSTALLATION_ID;
  const client = suppliedClient ?? createUniviewClient(config);
  const resolver = createHistoricalImageResolver(store, client, installation);
  const zones = database.zoneEnrichment ? createZoneEnricher(database.zoneEnrichment, client, installation) : undefined;
  const tasks = new Set<Promise<unknown>>(), controllers = new Set<AbortController>();
  const pendingImages = new Map<string, PendingImage>();
  const waiting: { start: () => void; cancel: () => void }[] = [];
  let active = 0, stopping = false, enriching = false;
  let resolving: Promise<unknown> = Promise.resolve();
  // One Smart Search owner; warm downloads may still use the second active slot.
  function resolveSerial<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    const task = resolving.then(() => { signal.throwIfAborted(); return work(); });
    resolving = task.then(() => undefined, () => undefined);
    return task;
  }
  function run<T>(work: (signal: AbortSignal) => Promise<T>, external?: AbortSignal): Promise<T> {
    if (stopping || tasks.size >= MEDIA_WORK_LIMITS.active + MEDIA_WORK_LIMITS.queued)
      return Promise.reject(new MediaFailure(503,'NVR_BUSY','TEMPORARILY_UNAVAILABLE'));
    const controller = new AbortController(); controllers.add(controller);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60000), ...(external ? [external] : [])]);
    const admission = new Promise<void>((accept, reject) => {
      const slot = {
        start() { signal.removeEventListener('abort', slot.cancel); active++; accept(); },
        cancel() {
          const index = waiting.indexOf(slot); if (index >= 0) waiting.splice(index, 1);
          signal.removeEventListener('abort', slot.cancel);
          reject(new MediaFailure(503,'MEDIA_UNAVAILABLE','TEMPORARILY_UNAVAILABLE'));
        },
      };
      if (signal.aborted) slot.cancel();
      else if (active < MEDIA_WORK_LIMITS.active) slot.start();
      else { waiting.push(slot); signal.addEventListener('abort', slot.cancel, { once: true }); }
    });
    const task = admission.then(async () => {
      try { signal.throwIfAborted(); return await work(signal); }
      finally { active--; waiting.shift()?.start(); }
    }).finally(() => { tasks.delete(task); controllers.delete(controller); });
    tasks.add(task); return task;
  }
  async function load(eventId: string, imageId?: string) {
    const event = await store.load(eventId);
    if (!event || event.sourceInstallationId !== installation) throw new MediaFailure(404,'NOT_FOUND','UNKNOWN');
    if (imageId === undefined) return event;
    const snapshot = event.snapshots.find((s) => s.id === imageId && s.eventId === eventId && s.origin === 'NVR_PUSH' && ['1','2'].includes(s.imageType ?? ''));
    if (!snapshot) throw new MediaFailure(event.snapshots.length > 64 ? 503 : 404,event.snapshots.length > 64 ? 'EVENT_IMAGE_LIMIT' : 'NOT_FOUND','UNRESOLVED');
    if (snapshot.status !== 'RECEIVED' || !snapshot.sha256 || !/^[a-f0-9]{64}$/.test(snapshot.sha256)) throw new MediaFailure(422,'ORIGINAL_IMAGE_UNAVAILABLE','UNRESOLVED');
    return { event, snapshot };
  }
  async function fetchVerified(snapshot: ResolutionSnapshot, signal: AbortSignal) {
    const ref = reference(snapshot); if (!ref) return null;
    let bytes: Buffer;
    try { bytes = originalJpeg(await client.historicalPicture(ref, signal)); }
    catch (error) {
      if (signal.aborted) throw new MediaFailure(503,'MEDIA_UNAVAILABLE','TEMPORARILY_UNAVAILABLE');
      if (error instanceof UniviewClientError && [404,410].includes(error.httpStatus ?? 0)) {
        await store.save(installation,snapshot,{status:'NOT_FOUND',reason:'historical_reference_not_found',checkedAt:new Date()}); return null;
      }
      await store.save(installation,snapshot,{status:'TEMPORARILY_UNAVAILABLE',reason:'historical_picture_unavailable',checkedAt:new Date()});
      throw new MediaFailure(503,'NVR_UNAVAILABLE','TEMPORARILY_UNAVAILABLE');
    }
    if (createHash('sha256').update(bytes).digest('hex') !== snapshot.sha256) {
      await store.save(installation,snapshot,{status:'INTEGRITY_MISMATCH',reason:'download_hash_mismatch',checkedAt:new Date()});
      return null;
    }
    const saved = snapshot.referenceStatus === 'VERIFIED' || await store.save(installation,snapshot,{status:'VERIFIED',reason:null,checkedAt:new Date()});
    if (!saved) throw new MediaFailure(503,'CONCURRENT_UPDATE','UNRESOLVED');
    return bytes;
  }
  async function original(eventId: string, imageId: string, signal: AbortSignal) {
    try {
      const owned = await load(eventId,imageId); if (!('snapshot' in owned)) throw new MediaFailure(404,'NOT_FOUND','UNKNOWN');
      const bytes = await fetchVerified(owned.snapshot,signal); if (bytes) return bytes;
      return await resolveSerial(signal, async () => {
        // Keep only this operation's matching bytes, never a server image cache.
        // The resolver still validates source ownership, hash and associated scene.
        let verifiedBytes: Buffer | undefined;
        const imageResolver = createHistoricalImageResolver({
          load: id => store.load(id),
          save(...args) { signal.throwIfAborted(); return store.save(...args); },
        }, {
          searchObjects: (...args) => client.searchObjects(...args),
          async historicalPicture(...args) {
            const downloaded = originalJpeg(await client.historicalPicture(...args));
            if (createHash('sha256').update(downloaded).digest('hex') === owned.snapshot.sha256) verifiedBytes = downloaded;
            return downloaded;
          },
        }, installation);
        const result = await imageResolver.resolveEvent(eventId,{snapshotId:imageId,persist:true,signal});
        const state = result.snapshots[0]?.status ?? 'UNRESOLVED';
        if (state !== 'VERIFIED') throw new MediaFailure(state === 'INTEGRITY_MISMATCH' ? 502 : state === 'NOT_FOUND' ? 404 : 503,
          state === 'INTEGRITY_MISMATCH' ? 'IMAGE_INTEGRITY_MISMATCH' : state === 'NOT_FOUND' ? 'NVR_IMAGE_NOT_FOUND' : 'NVR_UNAVAILABLE',state);
        const current = await load(eventId,imageId);
        if (!('snapshot' in current) || current.snapshot.sha256 !== owned.snapshot.sha256 || !verifiedBytes)
          throw new MediaFailure(503,'CONCURRENT_UPDATE','UNRESOLVED');
        signal.throwIfAborted();
        return verifiedBytes;
      });
    } catch (error) {
      if (error instanceof MediaFailure) throw error;
      if (error instanceof ImageResolutionError && error.code === 'busy') throw new MediaFailure(503,'NVR_BUSY','TEMPORARILY_UNAVAILABLE');
      throw new MediaFailure(503,'MEDIA_UNAVAILABLE','TEMPORARILY_UNAVAILABLE');
    }
  }
  return {
    image(eventId,imageId,external) {
      if (stopping) return Promise.reject(new MediaFailure(503,'NVR_BUSY','TEMPORARILY_UNAVAILABLE'));
      if (external?.aborted) return Promise.reject(external.reason);
      const key = JSON.stringify([eventId,imageId]);
      let job = pendingImages.get(key);
      if (job?.controller.signal.aborted) { pendingImages.delete(key); job = undefined; }
      if (!job) {
        const controller = new AbortController();
        const created: PendingImage = { controller, consumers: new Set<symbol>(), promise: Promise.resolve(Buffer.alloc(0)) };
        created.promise = run(signal => original(eventId,imageId,signal),controller.signal)
          .finally(() => { if (pendingImages.get(key) === created) pendingImages.delete(key); });
        pendingImages.set(key, created); job = created;
      }
      if (job.consumers.size >= MEDIA_WORK_LIMITS.consumers) return Promise.reject(new MediaFailure(503,'NVR_BUSY','TEMPORARILY_UNAVAILABLE'));
      const shared = job, token = Symbol(); shared.consumers.add(token);
      return new Promise<Buffer>((accept, reject) => {
        let finished = false;
        const done = (cancel: boolean) => {
          if (finished) return false;
          finished = true; external?.removeEventListener('abort', abort); shared.consumers.delete(token);
          if (cancel && !shared.consumers.size) shared.controller.abort();
          return true;
        };
        const abort = () => { if (done(true)) reject(external?.reason); };
        external?.addEventListener('abort', abort, { once: true });
        shared.promise.then(bytes => { if (done(false)) accept(bytes); }, (error: unknown) => { if (done(false)) reject(error); });
        if (external?.aborted) abort();
      });
    },
    enrich(eventId,external) { return run(async (signal) => {
      if (enriching) throw new MediaFailure(503,'NVR_BUSY','TEMPORARILY_UNAVAILABLE');
      enriching = true;
      try {
        await load(eventId);
        const projection=await database.projectObjects?.(eventId,installation,signal) ?? null;
        const { images, evidence } = await resolveSerial(signal, async () => ({
          images: await resolver.resolveEvent(eventId,{persist:true,signal}),
          evidence: zones ? await zones.enrichEvent(eventId,signal) : null,
        }));
        return { eventId, projection, images, zones:evidence, aiInvoked:false };
      } catch (error) {
        if (error instanceof MediaFailure) throw error;
        throw new MediaFailure(503,'ENRICHMENT_UNAVAILABLE','TEMPORARILY_UNAVAILABLE');
      } finally { enriching = false; }
    },external); },
    async close() { stopping = true; controllers.forEach((c) => c.abort()); await Promise.allSettled(tasks); },
  };
}
