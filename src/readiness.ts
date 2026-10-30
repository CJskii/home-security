import type { Database } from './database.js';

export function createReadiness(database: Database, timeoutMs: number,
  observe: (ready: boolean, checkedAt?: number) => void) {
  let stopping = false;
  let pendingCheck: Promise<void> | undefined;
  return {
    stop() {
      stopping = true;
      observe(false);
    },
    async check(): Promise<boolean> {
      if (stopping) return false;
      // Keep the pending driver promise until it settles, even after an HTTP
      // timeout, so repeated probes cannot fill the pool with stalled queries.
      pendingCheck ??= Promise.resolve().then(() => database.checkReady()).finally(() => {
        pendingCheck = undefined;
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      let ready = false;
      try {
        await Promise.race([
          pendingCheck,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Readiness deadline exceeded')), timeoutMs);
          }),
        ]);
        ready = !stopping;
      } catch {
        // HTTP responses/logs intentionally omit driver errors and SQL.
      } finally {
        clearTimeout(timer);
      }
      observe(ready, Date.now());
      return ready;
    },
  };
}
