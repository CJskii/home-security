import { expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';

const client = vi.hoisted(() => ({
  securityEvent: { findUnique: vi.fn(async () => ({ id: 'event',objects:[] })) },
  univiewZoneVersion:{findMany:vi.fn(async()=>[])},
  eventSnapshot: { findMany: vi.fn(async () => []) },
  $queryRaw: vi.fn(async () => [{id:'event',eventTime:new Date('2026-10-14T12:00:00Z'),timestampSource:'ALARM_REPORTED_AT',sourceNotificationId:null,categories:[]}]), $disconnect: vi.fn(async () => {}),
}));
vi.mock('@prisma/adapter-pg', () => ({ PrismaPg: class {} }));
vi.mock('../src/generated/prisma/client.js', async (importOriginal) => ({ ...await importOriginal<typeof import('../src/generated/prisma/client.js')>(), PrismaClient: class {
  constructor() { return client; }
} }));
import { createDatabase } from '../src/database.js';

it('event detail queries canonical relations and read-only historical zone geometry', async () => {
  const database = createDatabase(loadConfig({ DATABASE_URL: 'postgresql://test:secret@invalid/security' }));
  expect(await database.events!.get('event')).toMatchObject({ id: 'event',timestampSource:'ALARM_REPORTED_AT' });
  expect(client.securityEvent.findUnique).toHaveBeenCalledWith({ where: { id: 'event' }, include: expect.objectContaining({ analysis:{include:{objectAnalyses:true}},processing:true,objects:expect.any(Object),snapshots:expect.any(Object) }) });
});

it('readiness depends only on active application tables, without legacy integration tables', async () => {
  const database = createDatabase(loadConfig({ DATABASE_URL: 'postgresql://test:secret@invalid/security' }));
  await database.checkReady();
  const sql = client.$queryRaw.mock.calls.at(-1) as unknown as [TemplateStringsArray];
  expect([...sql[0]].join('')).toMatch(/"SecurityEvent".*"UniviewNotification".*"EventSnapshot".*"EvidenceProcessing".*"EventAnalysis"/);
  expect([...sql[0]].join('')).toContain('"UniviewObject"');
  for (const name of ['UniviewZone', 'UniviewZoneVersion', 'ObjectZoneEvidence', 'ObjectZoneMembership']) expect([...sql[0]].join('')).toContain(name);
  expect([...sql[0]].join('')).not.toMatch(/Frigate/);
  await database.disconnect();
  expect(client.$disconnect).toHaveBeenCalledOnce();
});

it('keeps internal resolution references out of the existing snapshot metadata API', async () => {
  const database = createDatabase(loadConfig({ DATABASE_URL: 'postgresql://test:secret@invalid/security' }));
  await database.events!.snapshots('event', 5);
  const [query] = client.eventSnapshot.findMany.mock.calls[0]! as unknown as [{ select: Record<string, boolean> }];
  expect(query.select).toMatchObject({ sha256: true, capturedAt: true, imageType: true, notificationId: true });
  expect(Object.keys(query.select).some((field) => field.startsWith('nvr'))).toBe(false);
});
