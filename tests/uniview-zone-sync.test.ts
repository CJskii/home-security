import { afterEach, expect, it, vi } from 'vitest';
import { createZoneSynchronizer, ZONE_SYNC_INTERVAL_MS } from '../src/uniview/zone-sync.js';
import { observedZones } from '../src/uniview/zones.js';
import { buildReceiver } from '../src/uniview/app.js';
import { alarm, config, fixtureStore } from './uniview-fixtures.js';
import { notificationPaths } from '../src/uniview/schemas.js';
import { at, configuration, installation, zoneDatabase } from './zone-fixtures.js';
afterEach(() => vi.useRealTimers());
it('syncs immediately and every ten minutes, preserving last-known state on failure until recovery', async () => {
  vi.useFakeTimers(); const f = zoneDatabase(), failure = vi.fn();
  const accessZone = vi.fn(async () => configuration());
  const sync = createZoneSynchronizer(f.store, { accessZone }, installation, [1, 2], failure, () => new Date());
  sync.start(); await sync.refresh();
  expect(accessZone).toHaveBeenCalledTimes(2); expect(f.state().versions).toHaveLength(8);
  const previous = structuredClone(f.state());
  accessZone.mockRejectedValueOnce(new Error('private NVR error')).mockRejectedValueOnce(new Error('private NVR error'));
  await vi.advanceTimersByTimeAsync(ZONE_SYNC_INTERVAL_MS);
  expect(f.state()).toEqual(previous); expect(failure).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(ZONE_SYNC_INTERVAL_MS);
  expect(f.state().versions).toHaveLength(8); expect(accessZone).toHaveBeenCalledTimes(6);
  expect(f.state().versions[0]!.lastObservedAt.getTime()).toBeGreaterThan(previous.versions[0]!.lastObservedAt.getTime());
  await sync.close(); await vi.advanceTimersByTimeAsync(ZONE_SYNC_INTERVAL_MS);
  expect(accessZone).toHaveBeenCalledTimes(6);
});
it('coalesces internal startup/scheduled runs and aborts in-flight reads on shutdown', async () => {
  vi.useFakeTimers(); let aborted = false;
  const accessZone = vi.fn((_channel: number, signal?: AbortSignal) => new Promise<ReturnType<typeof configuration>>((_resolve, reject) => {
    signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
  }));
  const observe = vi.fn(async () => {}), failure = vi.fn();
  const sync = createZoneSynchronizer({ observe }, { accessZone }, installation, [1, 2], failure);
  sync.start(); sync.start(); const first = sync.refresh(); expect(sync.refresh()).toBe(first);
  await vi.advanceTimersByTimeAsync(ZONE_SYNC_INTERVAL_MS * 2);
  expect(accessZone).toHaveBeenCalledOnce();
  await sync.close(); expect(aborted).toBe(true); expect(observe).not.toHaveBeenCalled(); expect(failure).not.toHaveBeenCalled();
  expect(await sync.refresh()).toEqual([]);
  sync.start(); await vi.advanceTimersByTimeAsync(ZONE_SYNC_INTERVAL_MS);
  expect(accessZone).toHaveBeenCalledOnce();
});
it('rejects malformed channel observations atomically and still attempts the other camera', async () => {
  const f = zoneDatabase(), failure = vi.fn();
  await f.store.observe(installation, 1, observedZones(configuration()), at(0));
  const config = configuration(); config.Areas.PolygonInfoList[0]!.PointList = [];
  const accessZone = vi.fn().mockResolvedValueOnce(config).mockResolvedValueOnce(configuration());
  const sync = createZoneSynchronizer(f.store, { accessZone }, installation, [1, 2], failure, () => at(24));
  expect(await sync.refresh()).toEqual([{ channel: 1, status: 'FAILED' }, { channel: 2, status: 'SYNCED' }]);
  expect(f.versions()[0]!.lastObservedAt).toEqual(at(0)); expect(f.state().zones).toHaveLength(8);
  await sync.close();
});
it('receiver accepts alarms while startup sync is pending and closes sync before disconnecting', async () => {
  const f = fixtureStore(); let cancel!: () => void;
  const accessZone = vi.fn((_channel: number, signal?: AbortSignal) => new Promise<ReturnType<typeof configuration>>((_resolve, reject) => {
    cancel = () => reject(new Error('aborted')); signal?.addEventListener('abort', cancel, { once: true });
  }));
  const sync = createZoneSynchronizer({ observe: vi.fn() }, { accessZone }, installation, [1, 2], vi.fn());
  const close = vi.spyOn(sync, 'close'); const disconnect = vi.fn(async () => { expect(close).toHaveBeenCalledOnce(); });
  const service = buildReceiver(config, { uniview: f.store, checkReady: vi.fn(async () => {}), disconnect }, undefined, sync);
  try {
    const result = await service.app.inject({ method: 'POST', url: notificationPaths.ALARM, remoteAddress: config.UNIVIEW_NVR_IP!,
      payload: JSON.stringify(alarm()), headers: { 'content-type': 'application/json' } });
    expect(result.statusCode).toBe(200); expect(accessZone).toHaveBeenCalledOnce();
  } finally { await service.app.close(); }
  expect(disconnect).toHaveBeenCalledOnce();
});
it('receiver wires the real zone store and existing LAPI client to both startup reads', async () => {
  const f = fixtureStore(), zones = zoneDatabase();
  const request = vi.fn(async () => new Response(JSON.stringify({ Response: { ResponseCode: 0, StatusCode: 0, Data: configuration() } }), { headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', request);
  const service = buildReceiver({ ...config, UNIVIEW_USERNAME: 'test', UNIVIEW_PASSWORD: 'secret' }, {
    uniview: f.store, zones: zones.store, checkReady: async () => {}, disconnect: async () => {},
  });
  try {
    await service.app.ready(); await vi.waitFor(() => expect(zones.state().versions).toHaveLength(8));
    expect(request.mock.calls).toHaveLength(2);
    expect(zones.state().zones).toHaveLength(8);
    expect(zones.state().versions).toHaveLength(8);
  } finally { await service.app.close(); vi.unstubAllGlobals(); }
});
