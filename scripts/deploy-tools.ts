import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';

export class DeploymentValidationError extends Error {
  constructor(readonly component: string, message: string) { super(message); }
}
export function validationMessage(error: unknown): string {
  if (error instanceof DeploymentValidationError) return `Preflight ${error.component}: ${error.message}`;
  if (error instanceof Error) {
    const fields = /^Invalid configuration fields: ([A-Za-z0-9_., ]+)$/.exec(error.message)?.[1];
    if (fields) return `Preflight APPLICATION_CONFIG: invalid fields ${fields}. Review these settings in the protected environment; values withheld.`;
  }
  return 'Preflight COMPOSE_JSON: cannot validate resolved Compose JSON. Check Compose v2 and local dependencies; raw input withheld.';
}

export function deploymentConfig(input: unknown) {
  const plan = input as { services?: Record<string, { container_name?: string; environment?: NodeJS.ProcessEnv; networks?: Record<string, unknown>; ports?: { host_ip?: string; published?: string; target?: number }[] }>; networks?: Record<string, { external?: boolean }> };
  const api = plan.services?.api;
  const migrate = plan.services?.migrate;
  if (!api || !migrate || Object.keys(plan.services ?? {}).some((name) => !['api', 'migrate', 'receiver'].includes(name)) || api.container_name !== 'home-security-api') throw new DeploymentValidationError('COMPOSE_SERVICES', 'Expected api/migrate with optional receiver and container home-security-api. Review compose.local.yaml.');
  for (const network of ['coolify', 'infrastructure-net']) {
    if (!api.networks || !Object.hasOwn(api.networks, network) || plan.networks?.[network]?.external !== true) throw new DeploymentValidationError('COMPOSE_NETWORKS', 'Required external API networks missing. Declare coolify and infrastructure-net in compose.local.yaml.');
  }
  if (!migrate.networks || !Object.hasOwn(migrate.networks, 'coolify')) throw new DeploymentValidationError('COMPOSE_MIGRATION_NETWORK', 'Migration service requires coolify. Review compose.local.yaml.');
  if (api.ports?.length !== 1 || api.ports[0]?.host_ip !== '127.0.0.1' || String(api.ports[0]?.published) !== '3000' || api.ports[0]?.target !== 3000) throw new DeploymentValidationError('COMPOSE_PORTS', 'Expected loopback-only 127.0.0.1:3000:3000. Review compose.local.yaml.');
  const config = loadConfig({ ...api.environment, NODE_ENV: 'production' });
  loadConfig({ ...migrate.environment, NODE_ENV: 'production' });
  if (new URL(config.DATABASE_URL).pathname !== '/security_events') throw new DeploymentValidationError('APPLICATION_DATABASE', 'Expected the security_events application database. Review the protected database setting without printing it.');
  if (config.PORT !== 3000 || config.HOST !== '0.0.0.0' || api.environment?.DATABASE_URL !== migrate.environment?.DATABASE_URL) throw new DeploymentValidationError('APPLICATION_BINDING', 'Expected HOST/PORT for 0.0.0.0:3000 and matching API/migration database settings. Review protected configuration.');
  return { service: 'api' as const };
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    const action = process.argv[2];
    const input = readFileSync(0, 'utf8');
    if (action === 'config') {
      deploymentConfig(JSON.parse(input));
      process.stdout.write('valid\n');
    } else throw new Error('Unknown helper operation');
  } catch (error) {
    process.stderr.write(`${validationMessage(error)}\n`);
    process.exitCode = 1;
  }
}
