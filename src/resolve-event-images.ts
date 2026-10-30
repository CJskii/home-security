import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { createDatabase } from './database.js';
import { createUniviewClient } from './uniview/snapshot-client.js';
import { createHistoricalImageResolver } from './uniview/historical-image-resolution.js';

export const resolutionUsage = 'node --env-file=.env.local dist/resolve-event-images.js --event <UUID> --installation <UUID> [--dry-run | --persist]';
export function parseResolutionArguments(args: string[]) {
  let event: string | undefined, installation: string | undefined, mode: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    if (value === '--event' && event === undefined) event = args[++i];
    else if (value === '--installation' && installation === undefined) installation = args[++i];
    else if ((value === '--persist' || value === '--dry-run') && mode === undefined) mode = value;
    else throw new Error('Invalid resolution arguments');
  }
  const result = z.object({ event: z.uuid(), installation: z.uuid() }).safeParse({ event, installation });
  if (!result.success) throw new Error('Invalid resolution arguments');
  return { event: result.data.event.toLowerCase(), installation: result.data.installation.toLowerCase(), persist: mode === '--persist' };
}
export async function runResolutionCommand(args: string[], env: NodeJS.ProcessEnv,
  dependencies = { database: createDatabase, client: createUniviewClient }) {
  const selected = parseResolutionArguments(args);
  const config = loadConfig(env);
  if (config.UNIVIEW_INSTALLATION_ID !== selected.installation) throw new Error('Resolution installation mismatch');
  const database = dependencies.database(config);
  try {
    if (!database.historicalImages) throw new Error('Resolution store unavailable');
    const resolver = createHistoricalImageResolver(database.historicalImages, dependencies.client(config), selected.installation);
    return await resolver.resolveEvent(selected.event, { persist: selected.persist });
  } finally { await database.disconnect(); }
}
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  if (process.argv.length === 3 && process.argv[2] === '--help') process.stdout.write(`${resolutionUsage}\nDefault: dry run. No migrations, backfill, services or image files.\n`);
  else void runResolutionCommand(process.argv.slice(2), process.env).then((report) => {
    // Only internal UUIDs, fixed statuses/reasons and persistence flags; never source references/media.
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (!report.snapshots.length || report.snapshots.some((s) => s.status !== 'VERIFIED')) process.exitCode = 2;
  }).catch(() => {
    process.stderr.write('Selected-event resolution failed; details withheld. Check arguments, protected environment and approved schema compatibility. No migrations were run.\n');
    process.exitCode = 1;
  });
}
