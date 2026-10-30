import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { buildApp } from './app.js';
import { buildReceiver } from './uniview/app.js';
import { DEFAULT_SERVICE_NAME, loadConfig } from './config.js';
import { createDatabase } from './database.js';
import { createShutdown, installFatalHandlers } from './lifecycle.js';

export async function main(role: 'api' | 'receiver') {
  loadEnv({ quiet: true });
  const config = loadConfig(process.env);
  if (role === 'receiver' && !config.UNIVIEW_ENABLED) throw new Error('Receiver disabled');
  const database = createDatabase(config);
  const service = role === 'receiver' ? buildReceiver(config, database) : buildApp(config, database);
  const { app, markStopping } = service;
  const shutdown = createShutdown({
    app, markStopping, timeoutMs: config.SHUTDOWN_TIMEOUT_MS,
    exit: (code) => process.exit(code),
  });
  const removeFatalHandlers = installFatalHandlers({
    events: process, log: app.log, markStopping, exit: (code) => process.exit(code),
  });
  const onSignal = (signal: NodeJS.Signals) => {
    void shutdown(signal).finally(() => {
      process.off('SIGTERM', onSignal);
      process.off('SIGINT', onSignal);
      removeFatalHandlers();
    });
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  try {
    await app.listen({ host: config.HOST, port: config.PORT });
  } catch {
    app.log.fatal({ errorCode: 'STARTUP_FAILED' }, 'Service startup failed');
    process.exitCode = 1;
    await shutdown('startup_failure');
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    removeFatalHandlers();
  }
}

export function run(role: 'api' | 'receiver') { void main(role).catch((error: unknown) => {
  // Only loadConfig emits this safe field-only message; never print raw errors.
  const message = error instanceof Error && error.message.startsWith('Invalid configuration fields:')
    ? error.message : 'Service initialization failed';
  const environment = ['development', 'test', 'production'].includes(process.env.NODE_ENV ?? '')
    ? process.env.NODE_ENV : 'unknown';
  process.stderr.write(`${JSON.stringify({
    level: 60, time: new Date().toISOString(), pid: process.pid,
    service: DEFAULT_SERVICE_NAME, environment, errorCode: 'INITIALIZATION_FAILED', msg: message,
  })}\n`);
  process.exitCode = 1;
});
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) run('api');
