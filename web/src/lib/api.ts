import { z } from "zod";
export const sessionEvents = new EventTarget();
export class ApiError extends Error {
  constructor(public status: number) {
    super(
      status === 401
        ? "Your session has ended. Sign in to continue."
        : status === 503
          ? "The service is temporarily unavailable. Please retry."
          : "The request could not be completed. Please retry.",
    );
  }
}
export async function api<T>(
  path: string,
  schema: z.ZodType<T>,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    if (response.status === 401) sessionEvents.dispatchEvent(new Event("ended"));
    throw new ApiError(response.status);
  }
  return schema.parse(await response.json());
}
// Bound browser requests independently of the NVR's serialized cold-search path.
export class ImageQueue {
  private active = 0;
  private waiting: { start: () => void; priority: () => number }[] = [];
  constructor(private readonly concurrency = 1) {}
  async run<T>(operation: () => Promise<T>, signal: AbortSignal, priority: () => number = () => 0): Promise<T> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const start = () => {
        signal.removeEventListener("abort", abort);
        this.active++;
        resolve();
      };
      const abort = () => {
        this.waiting = this.waiting.filter((job) => job.start !== start);
        reject(signal.reason);
      };
      if (this.active < this.concurrency) start();
      else {
        this.waiting.push({ start, priority });
        signal.addEventListener("abort", abort, { once: true });
      }
    });
    try {
      signal.throwIfAborted();
      return await operation();
    } finally {
      this.active--;
      // Sample priority at dispatch: scrolling can make a queued prefetch visible.
      if (this.waiting.length) {
        const highest = this.waiting.reduce((best, job, index) => job.priority() > this.waiting[best]!.priority() ? index : best, 0);
        this.waiting.splice(highest, 1)[0]!.start();
      }
    }
  }
}
export const imageQueue = new ImageQueue(2);
export function rangeParams(camera: string, days: string, now: number) {
  const params = new URLSearchParams({
    occurredAfter: new Date(now - Number(days) * 86400000).toISOString(),
    occurredBefore: new Date(now).toISOString(),
  });
  if (camera !== "all") params.set("camera", camera);
  return params;
}
export const display = (value: string) =>
  value.toLowerCase().replaceAll("_", " ");
export const formatTime = (value: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
// Gallery thumbnails are native crops; full frames remain detail-demanded.
export function thumbnail(event: import("./contracts").SecurityEvent) {
  for (const object of event.objects) {
    const crop = event.images.find(
      (image) => image.id === object.images.cropId && image.type === 2,
    );
    if (crop) return crop;
  }
  return undefined;
}
