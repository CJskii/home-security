import { cameraSnapshotSchema, type CameraConfigurationStore } from './camera-configuration.js';
import type { UniviewClient } from './snapshot-client.js';
import { observedZones, type ZoneObservationStore } from './zones.js';
export const ZONE_SYNC_INTERVAL_MS = 10 * 60 * 1000;
export class ConfigurationRefreshBusy extends Error {
  constructor() { super('Camera configuration refresh already in progress'); }
}
export function createZoneSynchronizer(store: ZoneObservationStore, client: Pick<UniviewClient, 'accessZone'>,
  installationId: string, channels: readonly number[], failure: () => void, now: () => Date = () => new Date(), metadata?: {store:CameraConfigurationStore; client:Pick<UniviewClient,'cameraName'|'videoStreams'>}) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let active: Promise<{ channel: number; status: 'SYNCED' | 'FAILED' }[]> | undefined;
  let controller: AbortController | undefined;
  let stopping = false;
  function refresh(selectedChannel?: number, rejectOverlap = false) {
    if (stopping) return Promise.resolve([]);
    if (selectedChannel !== undefined && !channels.includes(selectedChannel)) return Promise.reject(new Error('Unknown camera channel'));
    if (active) return rejectOverlap ? Promise.reject(new ConfigurationRefreshBusy()) : active;
    controller = new AbortController();
    const lifetime = controller.signal;
    active = (async () => {
      const results: { channel: number; status: 'SYNCED' | 'FAILED' }[] = [];
      for (const channel of channels.filter(value => selectedChannel === undefined || value === selectedChannel)) {
        if (lifetime.aborted) break;
        const signal=AbortSignal.any([lifetime,AbortSignal.timeout(20000)]);
        try {
          const zones = observedZones(await client.accessZone(channel, signal));
          const snapshot=metadata ? cameraSnapshotSchema.parse({name:await metadata.client.cameraName(channel,signal),streams:await metadata.client.videoStreams(channel,signal)}) : undefined;
          if (signal.aborted) throw new Error('Configuration refresh aborted');
          if (metadata && snapshot) await metadata.store.observe(installationId,channel,zones,snapshot,now());
          else await store.observe(installationId, channel, zones, now());
          results.push({ channel, status: 'SYNCED' });
        } catch { if (!stopping) { failure(); try { await metadata?.store.failed(installationId,channel,now()); } catch { /* Preserve the last verified snapshot even if status persistence fails. */ } results.push({ channel, status: 'FAILED' }); } }
      }
      return results;
    })().finally(() => { active = undefined; controller = undefined; });
    return active;
  }
  return {
    refresh,
    start() {
      if (timer || stopping) return;
      timer = setInterval(() => {
        void refresh().then(results => {
          // A due full pass may join a selected-camera manual read. Once it
          // finishes, cover both channels rather than postponing the other one.
          if (!stopping && results.length < channels.length) void refresh();
        });
      }, ZONE_SYNC_INTERVAL_MS); timer.unref();
      void refresh(); // Optional NVR metadata must never gate alarm acceptance.
    },
    async close() { stopping = true; if (timer) clearInterval(timer); controller?.abort(); await active; },
  };
}
export type ZoneSynchronizer = ReturnType<typeof createZoneSynchronizer>;
