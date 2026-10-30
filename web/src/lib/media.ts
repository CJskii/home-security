import { imageQueue, sessionEvents, type ImageQueue } from "./api";
export const MEDIA_CACHE_BYTES = 48 * 1024 * 1024;
export const MEDIA_CACHE_ENTRIES = 512;
const MEDIA_PATH = /^\/api\/events\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/images\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const validMediaPath = (path: string) => MEDIA_PATH.test(path);
type Entry = { url: string; bytes: number };
type Job = {
  controller: AbortController;
  promise: Promise<string>;
  started: boolean;
  consumers: Set<() => number>;
};
// Session-owned URLs retain JPEG bytes in browser RAM. No time expiry/disk cache.
// Viewers may detach; only LRU eviction or session clear releases a cached URL.
export class MediaLoader {
  private cache = new Map<string, Entry>();
  private jobs = new Map<string, Job>();
  private listeners = new Map<string, Set<() => void>>();
  private bytes = 0;
  constructor(
    private readonly maxBytes = MEDIA_CACHE_BYTES,
    private readonly maxEntries = MEDIA_CACHE_ENTRIES,
    private readonly queue: ImageQueue = imageQueue,
  ) {}
  getCached(path: string | undefined): string | undefined {
    return path ? this.cache.get(path)?.url : undefined;
  }
  subscribe(path: string | undefined, listener: () => void) {
    if (!path) return () => {};
    const group = this.listeners.get(path) ?? new Set();
    group.add(listener);
    this.listeners.set(path, group);
    return () => {
      group.delete(listener);
      if (!group.size) this.listeners.delete(path);
    };
  }
  private notify(path: string) {
    this.listeners.get(path)?.forEach((listener) => listener());
  }
  private remove(path: string) {
    const entry = this.cache.get(path);
    if (!entry) return;
    this.bytes -= entry.bytes;
    this.cache.delete(path);
    URL.revokeObjectURL(entry.url);
    this.notify(path);
  }
  clear() {
    for (const job of this.jobs.values()) job.controller.abort();
    this.jobs.clear();
    for (const path of this.cache.keys()) this.remove(path);
  }
  usage() {
    return { bytes: this.bytes, entries: this.cache.size,
      active: [...this.jobs.values()].filter((job) => job.started).length,
      queued: [...this.jobs.values()].filter((job) => !job.started).length };
  }
  async load(path: string, signal: AbortSignal, priority: () => number = () => 0): Promise<string> {
    signal.throwIfAborted();
    if (!validMediaPath(path)) throw new Error("Invalid media reference");
    const cached = this.cache.get(path);
    if (cached) {
      this.cache.delete(path);
      this.cache.set(path, cached);
      return cached.url;
    }
    let job = this.jobs.get(path);
    if (job?.controller.signal.aborted) {
      this.jobs.delete(path);
      job = undefined;
    }
    if (!job) {
      const controller = new AbortController();
      const created: Job = { controller, consumers: new Set(), started: false, promise: Promise.resolve("") };
      created.promise = this.queue.run(async () => {
        created.started = true;
        const response = await fetch(path, {
          credentials: "same-origin", cache: "no-store",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]),
        });
        if (!response.ok) {
          if (response.status === 401) {
            this.clear();
            sessionEvents.dispatchEvent(new Event("ended"));
            throw new Error("Sign in again to view images");
          }
          const body: unknown = await response.json();
          const code = body && typeof body === "object" && "code" in body ? body.code : undefined;
          throw new Error(code === "NVR_IMAGE_NOT_FOUND" ? "Original not found on NVR" : response.status === 503 ? "NVR busy · retry shortly" : "Original image unavailable");
        }
        if (!response.headers.get("content-type")?.startsWith("image/jpeg")) throw new Error("Invalid image response");
        const blob = await response.blob();
        controller.signal.throwIfAborted();
        if (blob.size > this.maxBytes || this.maxEntries < 1) throw new Error("Original image exceeds browser memory limit");
        while (this.bytes + blob.size > this.maxBytes || this.cache.size >= this.maxEntries) this.remove(this.cache.keys().next().value!);
        const url = URL.createObjectURL(blob);
        this.cache.set(path, { url, bytes: blob.size });
        this.bytes += blob.size;
        this.notify(path);
        return url;
      }, controller.signal, () => Math.max(0, ...[...created.consumers].map((rank) => rank())))
        .finally(() => { if (this.jobs.get(path) === created) this.jobs.delete(path); });
      job = created;
      this.jobs.set(path, job);
    }
    const current = job;
    // Distinct tokens let identical viewer priorities share transport safely.
    const rank = () => priority();
    current.consumers.add(rank);
    return new Promise<string>((resolve, reject) => {
      let finished = false;
      const done = () => {
        if (finished) return false;
        finished = true;
        signal.removeEventListener("abort", abort);
        current.consumers.delete(rank);
        // Cancel unstarted work. Brief React remounts can reattach in this turn.
        // Started work finishes into the cache (at most two bounded requests).
        queueMicrotask(() => {
          if (!current.consumers.size && !current.started && this.jobs.get(path) === current) current.controller.abort();
        });
        return true;
      };
      const abort = () => { if (done()) reject(signal.reason); };
      signal.addEventListener("abort", abort, { once: true });
      current.promise.then((url) => { if (done()) resolve(url); }, (error: unknown) => { if (done()) reject(error); });
      if (signal.aborted) abort();
    });
  }
}
export const mediaLoader = new MediaLoader();
sessionEvents.addEventListener("ended", () => mediaLoader.clear());
