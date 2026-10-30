import process from 'node:process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Never render arbitrary log messages, metadata or remote exception text. Only
// the fixed vocabulary from current application lifecycle code is shown.
export function safeLogs(input) {
  const entries = [];
  for (const line of input.split('\n')) {
    try {
      const row = JSON.parse(line);
      const time = typeof row.time === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(row.time) ? row.time : undefined;
      if (['DATABASE_NOT_READY', 'UNIVIEW_STORAGE_UNAVAILABLE', 'EVENT_DATABASE_WRITE_FAILED'].includes(String(row.errorCode))) {
        entries.push({ ...(time ? { time } : {}), kind: 'error', value: String(row.errorCode) });
      }
    } catch { /* Plaintext, malformed and unrecognised entries are intentionally omitted. */ }
  }
  return entries;
}

// Emit only code-defined categories, npm script names and numeric counts. Never
// echo arbitrary compiler/test errors: they may contain environment values.
export function validationSummary(input) {
  const steps = [...input.matchAll(/^> (?:[^\r\n]+ )?(prisma:generate|prisma:validate|lint|typecheck|test|build)\r?$/gm)];
  const step = steps.at(-1)?.[1] ?? 'unknown';
  let category = 'command failure';
  if (/AssertionError:/.test(input)) category = 'test assertion failure';
  else if (/error TS\d+:/.test(input)) category = 'TypeScript compilation failure';
  else if (/ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|command not found|not found:/.test(input)) category = 'missing dependency or executable';
  else if (/EACCES|EPERM/.test(input)) category = 'permission denied';
  else if (/heap out of memory|ENOMEM/.test(input)) category = 'memory exhaustion';
  else if (step === 'lint') category = 'lint failure';
  else if (step.startsWith('prisma:')) category = 'Prisma validation/generation failure';
  const failed = /^\s*Tests\s+(\d{1,6}) failed/m.exec(input)?.[1];
  return `Local validation: ${category}; npm stage: ${step}${failed ? `; failed tests: ${failed}` : ''}. Raw output withheld. Reproduce with (umask 077; npm run check) under Node 24 in the repository.`;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    const action = process.argv[2];
    const input = readFileSync(0, 'utf8');
    if (action === 'validation') {
      process.stdout.write(`${validationSummary(input)}\n`);
    } else if (action === 'logs') {
      for (const entry of safeLogs(input).slice(-20)) process.stdout.write(`${entry.time ?? 'UTC unavailable'} ${entry.kind}: ${entry.value}\n`);
    } else if (action === 'probe') {
      process.exitCode = JSON.parse(input).status === process.argv[3] ? 0 : 1;
    } else throw new Error('Unknown diagnostic operation');
  } catch {
    process.stderr.write('Diagnostic parser failed; raw input withheld. Check the diagnostic component and retry.\n');
    process.exitCode = 1;
  }
}
