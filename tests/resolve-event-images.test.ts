import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { parseResolutionArguments, runResolutionCommand } from '../src/resolve-event-images.js';
import type { Database } from '../src/database.js';
import type { ResolutionEvent } from '../src/uniview/historical-image-resolution.js';
import type { UniviewClient } from '../src/uniview/snapshot-client.js';
import { config, jpeg } from './uniview-fixtures.js';
const eventId = '17b01e57-cc3d-4db5-9bdd-f7d89e8149bb', installation = config.UNIVIEW_INSTALLATION_ID!;
const args = ['--event', eventId, '--installation', installation];
const env = { DATABASE_URL: config.DATABASE_URL, UNIVIEW_INSTALLATION_ID: installation };
function setup() {
  const event: ResolutionEvent = { id: eventId, sourceInstallationId: installation, nvrChannel: 1, alarmType: 'EnterArea',
    notifications: [{ id: 'notification', eventId, reportedAt: new Date(1700000000000), metadata: {} }], snapshots: [{
      id: 'snapshot', eventId, notificationId: 'notification', origin: 'NVR_PUSH', status: 'RECEIVED', imageType: '1',
      sha256: createHash('sha256').update(jpeg).digest('hex'), sourceImageIndex: 1, capturedAt: new Date(1700000000000),
      nvrPictureName: null, nvrPictureSize: null, nvrPictureType: null, nvrRecordId: null, referenceVersion: 0, referenceResolvedAt: null,
    }] };
  const load = vi.fn(async () => event), save = vi.fn(async () => true), disconnect = vi.fn(async () => {});
  const database = vi.fn((): Database => ({ historicalImages: { load, save }, checkReady: async () => {}, disconnect }));
  const searchObjects = vi.fn(async () => []);
  const client = vi.fn(() => ({ searchObjects } as unknown as UniviewClient));
  return { dependencies: { database, client }, save, disconnect, searchObjects };
}
it('defaults to one-event dry-run and disconnects without writes or background processing', async () => {
  const f = setup(); const report = await runResolutionCommand(args, env, f.dependencies);
  expect(report.persist).toBe(false); expect(report.snapshots[0]!.status).toBe('NOT_FOUND');
  expect(f.save).not.toHaveBeenCalled(); expect(f.disconnect).toHaveBeenCalledOnce(); expect(f.searchObjects).toHaveBeenCalledOnce();
});
it('requires explicit persist mode and installation match before metadata writes', async () => {
  const f = setup(); const report = await runResolutionCommand([...args, '--persist'], env, f.dependencies);
  expect(report.persist).toBe(true); expect(f.save).toHaveBeenCalledOnce(); expect(f.disconnect).toHaveBeenCalledOnce();
  f.dependencies.database.mockClear();
  await expect(runResolutionCommand(args, { ...env, UNIVIEW_INSTALLATION_ID: '27b01e57-cc3d-4db5-9bdd-f7d89e8149bb' }, f.dependencies)).rejects.toThrow('installation');
  expect(f.dependencies.database).not.toHaveBeenCalled();
});
it('refuses bulk, duplicate, unknown and incomplete arguments before accessing a database', async () => {
  for (const invalid of [[], ['--all'], [...args, '--event', eventId], [...args, '--persist', '--dry-run'], [...args, '--unexpected'], ['--event', eventId]]) {
    expect(() => parseResolutionArguments(invalid)).toThrow('Invalid resolution arguments');
    const f = setup(); await expect(runResolutionCommand(invalid, env, f.dependencies)).rejects.toThrow();
    expect(f.dependencies.database).not.toHaveBeenCalled();
  }
});
it('help is offline and needs no credentials or environment file', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../src/resolve-event-images.ts', import.meta.url)), '--help'], { env: {}, encoding: 'utf8', timeout: 10000 });
  expect(result.status).toBe(0); expect(result.stderr).toBe(''); expect(result.stdout).toContain('Default: dry run');
});
