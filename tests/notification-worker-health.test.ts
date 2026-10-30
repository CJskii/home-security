import { expect, it, vi } from 'vitest';
import { workerHeartbeat, workerHealthFresh, WORKER_HEALTH_MAX_AGE_MS } from '../src/notifications/worker-health.js';
const now = 1_000_000;
it('requires a recent successful tick from the actual live worker', () => {
    const alive = vi.fn(() => true);
    expect(workerHealthFresh({ pid: 7, successfulTickAt: now - 1000 }, now, alive)).toBe(true);
    expect(alive).toHaveBeenCalledWith(7);
    expect(workerHealthFresh({ pid: 7, successfulTickAt: now }, now, () => false)).toBe(false);
});
it.each([null, {}, { pid: 1, successfulTickAt: now }, { pid: '7', successfulTickAt: now },
    { pid: 7, successfulTickAt: 'recent' }, { pid: 7, successfulTickAt: NaN },
    { pid: 7, successfulTickAt: now + 5001 }, { pid: 7, successfulTickAt: now - WORKER_HEALTH_MAX_AGE_MS - 1 }])('rejects absent, malformed, stale or future state: %j', value => {
    expect(workerHealthFresh(value, now, () => true)).toBe(false);
});
it('publishes progress only when called after successful work, and clears on failure/shutdown', () => {
    let stored: string | null = null;
    const io = { write: (s: string) => { stored = s; }, clear: () => { stored = null; } };
    const heartbeat = workerHeartbeat(io, 7, () => now);
    expect(stored).toBeNull();
    expect(heartbeat.mark()).toBe(true);
    expect(JSON.parse(stored!)).toEqual({ pid: 7, successfulTickAt: now });
    heartbeat.clear(); expect(stored).toBeNull();
    expect(heartbeat.mark()).toBe(true); // recovery
});
it('does not manufacture success or interrupt delivery if health storage fails', () => {
    const heartbeat = workerHeartbeat({ write: () => { throw Error('fixture'); }, clear: () => { throw Error('fixture'); } }, 7);
    expect(heartbeat.mark()).toBe(false);
    expect(() => heartbeat.clear()).not.toThrow();
});
