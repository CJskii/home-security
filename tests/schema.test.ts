import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
const sql = readFileSync(new URL('../prisma/migrations/20261014020000_uniview_capture/migration.sql', import.meta.url), 'utf8');
it('migration scopes destructive work to enumerated application objects, preserves migration history and refuses cascade', () => {
  expect(sql).toContain("current_database() <> 'security_events'"); expect(sql).toContain("SET LOCAL lock_timeout = '3s'");
  expect(sql).not.toMatch(/DROP (?:TABLE|TYPE)[^;]*CASCADE;/i); expect(sql).not.toMatch(/DROP (SCHEMA|DATABASE)/i);
  expect(sql).toContain('DROP FUNCTION public.reject_visual_evidence_score_mutation();'); expect(sql).not.toContain('"_prisma_migrations"');
  const drops = sql.match(/DROP TABLE ([^;]+);/)![1]!;
  expect(drops.split(',')).toHaveLength(11); expect(sql).toContain('BEGIN;'); expect(sql.trim().endsWith('COMMIT;')).toBe(true);
});
it('PostgreSQL uniqueness and composite FK fence authoritative identity and snapshot ownership', () => {
  expect(sql).toMatch(/CREATE UNIQUE INDEX .* ON "SecurityEvent"\("sourceInstallationId", "nvrChannel", "alarmType", "relatedId"\)/);
  expect(sql).toContain('FOREIGN KEY ("eventId", "notificationId") REFERENCES "UniviewNotification"("eventId", "id")');
  expect(sql).toMatch(/CREATE UNIQUE INDEX .* ON "SnapshotBlob"\("sha256"\)/);
  expect(sql).toContain('"EventSnapshot_availability"');
});

it('M1.5 preserves capture descriptors and canonical events, removing only the blob archive', () => {
  const migration = readFileSync(new URL('../prisma/migrations/20261014030000_memory_evidence/migration.sql', import.meta.url), 'utf8');
  expect(migration).toContain('FROM "SnapshotBlob" b WHERE s."blobId"=b."id"');
  expect(migration).toContain('DROP TABLE "SnapshotBlob";');
  expect(migration).not.toMatch(/DROP (SCHEMA|DATABASE)|DELETE FROM|TRUNCATE|CASCADE;/i);
  expect(migration).toContain('PRIMARY KEY ("eventId")');
});
