import { readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Local RAM-only state. No HTTP endpoint, credentials, event data or database writes.
export const WORKER_HEALTH_PATH = '/tmp/home-security-notification-worker-health.json';
export const WORKER_HEALTH_MAX_AGE_MS = 180_000;
export function workerHealthFresh(value: unknown, now: number, alive: (pid: number) => boolean): boolean {
    if (!value || typeof value !== 'object') return false;
    const record = value as { pid?: unknown; successfulTickAt?: unknown };
    if (typeof record.pid !== 'number' || !Number.isSafeInteger(record.pid) || record.pid <= 1 ||
        typeof record.successfulTickAt !== 'number' || !Number.isFinite(record.successfulTickAt)) return false;
    const age = now - record.successfulTickAt;
    return age >= -5000 && age <= WORKER_HEALTH_MAX_AGE_MS && alive(record.pid);
}
export function workerHeartbeat(io: { write: (value: string) => void; clear: () => void }, pid: number, now = Date.now) {
    return {
        mark() {
            try { io.write(JSON.stringify({ pid, successfulTickAt: now() })); return true; }
            catch { return false; }
        },
        clear() { try { io.clear(); } catch { /* An unreadable or stale marker fails the probe. */ } },
    };
}
export function localWorkerHeartbeat() {
    return workerHeartbeat({
        write(value) {
            writeFileSync(WORKER_HEALTH_PATH + '.next', value, { mode: 0o600 });
            renameSync(WORKER_HEALTH_PATH + '.next', WORKER_HEALTH_PATH);
        },
        clear() {
            rmSync(WORKER_HEALTH_PATH, { force: true });
            rmSync(WORKER_HEALTH_PATH + '.next', { force: true });
        },
    }, process.pid);
}
export function probeWorkerHealth() {
    try {
        const text = readFileSync(WORKER_HEALTH_PATH, 'utf8');
        return text.length <= 256 && workerHealthFresh(JSON.parse(text), Date.now(), pid => {
            try {
                process.kill(pid, 0);
                return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').some(arg => /(?:^|\/)dist\/notification-worker\.js$/.test(arg));
            } catch { return false; }
        });
    } catch { return false; }
}
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
    const healthy = probeWorkerHealth();
    if (!healthy) process.stderr.write('notification_worker_health_unavailable\n');
    process.exitCode = healthy ? 0 : 1;
}
