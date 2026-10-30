import { createHash } from "node:crypto";
import type { Config } from "../config.js";
import { MediaFailure, type NvrApi } from "../events/nvr-service.js";
import {
  createHistoricalImageResolver,
  type HistoricalImageStore,
} from "../uniview/historical-image-resolution.js";
import { originalJpeg } from "../uniview/jpeg.js";
import {
  createUniviewClient,
  UniviewClientError,
  type HistoricalPictureReference,
  type UniviewClient,
} from "../uniview/snapshot-client.js";

export const DEVELOPMENT_REFERENCE_LIMIT = 128;
export const DEVELOPMENT_REFERENCE_TTL_MS = 5 * 60_000;
// Metadata only. Each download is still checked against the current database hash.
export function createDevelopmentMedia(
  config: Config,
  store: HistoricalImageStore,
  supplied?: Pick<UniviewClient, "historicalPicture" | "searchObjects">,
  now: () => number = Date.now,
): NvrApi {
  const configured =
    config.UNIVIEW_INSTALLATION_ID &&
    config.UNIVIEW_NVR_IP &&
    config.UNIVIEW_USERNAME &&
    config.UNIVIEW_PASSWORD;
  const client = configured
    ? (supplied ?? createUniviewClient(config))
    : undefined;
  const references = new Map<
    string,
    { picture: HistoricalPictureReference; expires: number }
  >();
  const controllers = new Set<AbortController>(),
    tasks = new Set<Promise<Buffer>>();
  let closed = false,
    resolving: Promise<unknown> = Promise.resolve();
  return {
    image(eventId, imageId, external) {
      if (closed || tasks.size >= 2)
        return Promise.reject(
          new MediaFailure(503, "NVR_BUSY", "TEMPORARILY_UNAVAILABLE"),
        );
      if (!client)
        return Promise.reject(
          new MediaFailure(503, "NVR_NOT_CONFIGURED", "UNRESOLVED"),
        );
      const controller = new AbortController();
      controllers.add(controller);
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(60000),
        ...(external ? [external] : []),
      ]);
      const task = (async () => {
        try {
          const event = await store.load(eventId);
          if (
            !event ||
            event.sourceInstallationId !== config.UNIVIEW_INSTALLATION_ID
          )
            throw new MediaFailure(404, "NOT_FOUND", "UNKNOWN");
          const snapshot = event.snapshots.find(
            (s) =>
              s.id === imageId &&
              s.eventId === eventId &&
              s.origin === "NVR_PUSH" &&
              ["1", "2"].includes(s.imageType ?? ""),
          );
          if (!snapshot) throw new MediaFailure(404, "NOT_FOUND", "UNKNOWN");
          if (snapshot.status !== "RECEIVED" || !snapshot.sha256)
            throw new MediaFailure(
              422,
              "ORIGINAL_IMAGE_UNAVAILABLE",
              "UNRESOLVED",
            );
          const key = JSON.stringify([event.sourceInstallationId, snapshot]);
          const cached = references.get(key);
          if (cached && cached.expires > now()) {
            references.delete(key);
            references.set(key, cached);
            try {
              const bytes = originalJpeg(
                await client.historicalPicture(cached.picture, signal),
              );
              if (
                createHash("sha256").update(bytes).digest("hex") ===
                snapshot.sha256
              )
                return bytes;
            } catch (error) {
              references.delete(key);
              if (!(
                error instanceof UniviewClientError &&
                [404, 410].includes(error.httpStatus ?? 0)
              ))
                throw error;
            }
          }
          references.delete(key);
          // One cold resolution at a time; a warm reference download may run alongside it.
          const resolution = resolving.then(async () => {
            signal.throwIfAborted();
            let verifiedBytes: Buffer | undefined,
              reference: HistoricalPictureReference | undefined;
            const resolver = createHistoricalImageResolver(
              store,
              {
                searchObjects: (...args) => client.searchObjects(...args),
                async historicalPicture(...args) {
                  const bytes = originalJpeg(
                    await client.historicalPicture(...args),
                  );
                  if (
                    createHash("sha256").update(bytes).digest("hex") ===
                    snapshot.sha256
                  )
                    verifiedBytes = bytes;
                  return bytes;
                },
              },
              config.UNIVIEW_INSTALLATION_ID!,
            );
            const result = await resolver.resolveEvent(eventId, {
              snapshotId: imageId,
              persist: false,
              signal,
              onVerified: (id, picture) => {
                if (id === imageId) reference = picture;
              },
            });
            const state = result.snapshots[0]?.status ?? "UNRESOLVED";
            if (state !== "VERIFIED" || !reference || !verifiedBytes)
              throw new MediaFailure(
                state === "NOT_FOUND"
                  ? 404
                  : state === "INTEGRITY_MISMATCH"
                    ? 502
                    : 503,
                state === "NOT_FOUND"
                  ? "NVR_IMAGE_NOT_FOUND"
                  : state === "INTEGRITY_MISMATCH"
                    ? "IMAGE_INTEGRITY_MISMATCH"
                    : "MEDIA_UNAVAILABLE",
                state,
              );
            signal.throwIfAborted();
            for (const [id, value] of references)
              if (value.expires <= now()) references.delete(id);
            references.set(key, {
              picture: reference,
              expires: now() + DEVELOPMENT_REFERENCE_TTL_MS,
            });
            while (references.size > DEVELOPMENT_REFERENCE_LIMIT)
              references.delete(references.keys().next().value!);
            // These are the resolver's exact hash-matched bytes, after scene association checks.
            return verifiedBytes;
          });
          resolving = resolution.then(
            () => undefined,
            () => undefined,
          );
          return await resolution;
        } catch (error) {
          if (error instanceof MediaFailure) throw error;
          throw new MediaFailure(
            503,
            "MEDIA_UNAVAILABLE",
            "TEMPORARILY_UNAVAILABLE",
          );
        }
      })().finally(() => {
        tasks.delete(task);
        controllers.delete(controller);
      });
      tasks.add(task);
      return task;
    },
    async enrich() {
      throw new MediaFailure(405, "DEVELOPMENT_READ_ONLY", "UNRESOLVED");
    },
    async close() {
      closed = true;
      controllers.forEach((c) => c.abort());
      await Promise.allSettled(tasks);
      references.clear();
    },
  };
}
