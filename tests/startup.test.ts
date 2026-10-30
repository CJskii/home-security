import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('fails production initialization with safe UTC JSON before creating a database', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../src/server.ts', import.meta.url))], {
    encoding: 'utf8', timeout: 10000,
    env: {
      NODE_ENV: 'production',
      DATABASE_URL: 'https://test:unit-secret@invalid/security',
      METRICS_ENABLED: 'true', METRICS_TOKEN: 'too-short-unit-secret',
    },
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).not.toContain('unit-secret');
  const entry = JSON.parse(result.stderr.trim()) as Record<string, unknown>;
  expect(entry).toMatchObject({ level: 60, environment: 'production', errorCode: 'INITIALIZATION_FAILED' });
  expect(entry.time).toMatch(/Z$/);
  expect(entry.service).toBe('residential-security-backend');
  expect(entry.msg).toContain('Invalid configuration fields:');
});
