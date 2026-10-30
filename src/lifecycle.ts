import type { FastifyInstance } from 'fastify';
import type { EventEmitter } from 'node:events';

interface ShutdownOptions {
  app: { close(): Promise<unknown>; log: FastifyInstance['log'] };
  markStopping(): void;
  timeoutMs: number;
  exit(code: number): void;
}

export function createShutdown({ app, markStopping, timeoutMs, exit }: ShutdownOptions) {
  let pending: Promise<void> | undefined;
  return (reason: string): Promise<void> => {
    if (pending) return pending;
    markStopping();
    app.log.info({ reason }, 'Shutting down');
    const deadline = setTimeout(() => {
      app.log.fatal({ errorCode: 'SHUTDOWN_DEADLINE_EXCEEDED' }, 'Shutdown deadline exceeded');
      exit(1);
    }, timeoutMs);
    pending = Promise.resolve().then(() => app.close()).then(() => {
      app.log.info('Shutdown complete');
    }, () => {
      app.log.error({ errorCode: 'SHUTDOWN_FAILED' }, 'Shutdown failed');
      exit(1);
    }).finally(() => { clearTimeout(deadline); });
    return pending;
  };
}

// Unknown process failures are unsafe to recover from. Suppress Node's default
// raw exception/stack output, log a fixed category, and let the supervisor restart.
export function installFatalHandlers({ events, log, markStopping, exit }: {
  events: Pick<EventEmitter, 'on' | 'off'>;
  log: FastifyInstance['log'];
  markStopping(): void;
  exit(code: number): void;
}): () => void {
  const fail = (errorCode: string) => {
    markStopping();
    log.fatal({ errorCode }, 'Unhandled process failure');
    exit(1);
  };
  const onException = () => { fail('UNCAUGHT_EXCEPTION'); };
  const onRejection = () => { fail('UNHANDLED_REJECTION'); };
  events.on('uncaughtException', onException);
  events.on('unhandledRejection', onRejection);
  return () => {
    events.off('uncaughtException', onException);
    events.off('unhandledRejection', onRejection);
  };
}
