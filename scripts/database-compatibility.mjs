// Host-side metadata comparison only. This module never connects to a database.
import process from 'node:process';
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

export const historySql = `BEGIN READ ONLY;
SET LOCAL statement_timeout = '3000ms';
SET LOCAL lock_timeout = '1000ms';
SELECT COALESCE(json_agg(history), '[]'::json) FROM
(SELECT migration_name, checksum, finished_at, rolled_back_at
 FROM public."_prisma_migrations" LIMIT 1001) AS history;
COMMIT;
`;

export class MigrationHistoryError extends Error {}
export function reviewHistory(files, rows) {
  if (rows.length === 0) throw new MigrationHistoryError('empty migration history');
  for (const row of rows) {
    if (!files.has(row.migration_name)) throw new MigrationHistoryError('unknown migration in database history');
    if (!row.finished_at && !row.rolled_back_at) throw new MigrationHistoryError('unresolved failed migration');
    if (row.finished_at && files.get(row.migration_name) !== row.checksum) throw new MigrationHistoryError('applied migration checksum mismatch');
  }
  const applied = new Set(rows.filter((row) => row.finished_at && !row.rolled_back_at).map((row) => row.migration_name));
  let gap = false;
  for (const name of [...files.keys()].sort()) {
    if (!applied.has(name)) gap = true;
    else if (gap) throw new MigrationHistoryError('noncontiguous applied migration history');
  }
  return gap ? 'pending' : 'current';
}

export function databaseTarget(config, container) {
  const url = new URL(config.services.api.environment.DATABASE_URL);
  const network = container.networks?.coolify;
  const names = [container.name?.replace(/^\//, ''), ...(network?.Aliases ?? []), ...(network?.DNSNames ?? [])];
  if (!network || !names.includes(url.hostname) || url.pathname !== '/security_events' ||
      (url.port && url.port !== '5432') || (url.searchParams.has('schema') && url.searchParams.get('schema') !== 'public')) {
    throw new MigrationHistoryError('selected PostgreSQL container does not match configured database host/port/schema');
  }
}

export function compatibleHistory(files, input) {
  if (!Array.isArray(input) || input.length > 1000 || input.some((row) => !row ||
      typeof row.migration_name !== 'string' || typeof row.checksum !== 'string' ||
      !(row.finished_at === null || typeof row.finished_at === 'string') ||
      !(row.rolled_back_at === null || typeof row.rolled_back_at === 'string'))) {
    throw new MigrationHistoryError('invalid or oversized migration metadata');
  }
  if (files.size === 0) throw new MigrationHistoryError('no checked-in migrations');
  if (reviewHistory(files, input) !== 'current') throw new MigrationHistoryError('pending migrations; apply reviewed migrations manually');
  return 'compatible';
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === 'sql') process.stdout.write(historySql);
    else if (process.argv[2] === 'target') {
      databaseTarget(JSON.parse(readFileSync(process.argv[3], 'utf8')), JSON.parse(readFileSync(process.argv[4], 'utf8')));
    } else if (process.argv[2] === 'history') {
      const root = resolve(fileURLToPath(new URL('../prisma/migrations/', import.meta.url)));
      const files = new Map(readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => [entry.name,
        createHash('sha256').update(readFileSync(resolve(root, entry.name, 'migration.sql'))).digest('hex')]));
      process.stdout.write(`${compatibleHistory(files, JSON.parse(readFileSync(0, 'utf8')))}\n`);
    } else throw new Error('Unknown operation');
  } catch (error) {
    process.stderr.write(`Database compatibility: ${error instanceof MigrationHistoryError ? error.message : 'metadata/configuration could not be read or validated'}; private values withheld.\n`);
    process.exitCode = 1;
  }
}
