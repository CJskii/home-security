import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { EventEmitter } from 'node:events';
import { createShutdown, installFatalHandlers } from '../src/lifecycle.js';

const log = { info: vi.fn(), fatal: vi.fn(), error: vi.fn() } as unknown as FastifyInstance['log'];
afterEach(() => { vi.useRealTimers(); });

function setup(close = vi.fn(async () => {})) {
  const markStopping = vi.fn();
  const exit = vi.fn();
  const shutdown = createShutdown({ app: { close, log }, markStopping, timeoutMs: 100, exit });
  return { shutdown, markStopping, close, exit };
}

describe('graceful shutdown', () => {
  it('marks unready before closing and handles repeated signals once', async () => {
    const { shutdown, markStopping, close, exit } = setup();
    const pending = shutdown('SIGTERM');
    expect(markStopping).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    expect(shutdown('SIGINT')).toBe(pending);
    await pending;
    expect(close).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
  });

  it('forces failure exit if draining exceeds the deadline', async () => {
    vi.useFakeTimers();
    const { shutdown, exit } = setup(vi.fn(() => new Promise<void>(() => {})));
    void shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(100);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('fails safely when disconnect or close rejects', async () => {
    const { shutdown, exit } = setup(vi.fn(async () => { throw new Error('unit-secret'); }));
    await shutdown('SIGINT');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('clears the deadline after successful draining', async () => {
    vi.useFakeTimers();
    const { shutdown, exit } = setup();
    await shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(1000);
    expect(exit).not.toHaveBeenCalled();
  });
});

describe('fatal process failures', () => {
  it.each([
    ['uncaughtException', 'UNCAUGHT_EXCEPTION'],
    ['unhandledRejection', 'UNHANDLED_REJECTION'],
  ])('fails closed on %s without logging the raw exception', (event, errorCode) => {
    const events = new EventEmitter();
    const markStopping = vi.fn();
    const exit = vi.fn();
    const cleanup = installFatalHandlers({ events, log, markStopping, exit });
    events.emit(event, new Error('unit-secret in raw stack'));
    expect(markStopping).toHaveBeenCalledOnce();
    expect(log.fatal).toHaveBeenCalledWith({ errorCode }, 'Unhandled process failure');
    expect(exit).toHaveBeenCalledWith(1);
    cleanup();
    expect(events.listenerCount(event)).toBe(0);
  });
});
