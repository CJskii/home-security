// Explicit operator smoke check: production reads only, two original JPEGs in RAM.
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import pg from "pg";
import {
  developmentConfig,
  protectedEnvironment,
} from "../src/dashboard/development-config.js";
import { readOnlyConnectionString } from "../src/dashboard/development-database.js";
import {
  pageSchema,
  eventSchema,
  camerasSchema,
  zonesSchema,
  streamsSchema,
  statisticsSchema,
} from "../web/src/lib/contracts.js";
const root = fileURLToPath(new URL("../", import.meta.url));
let stage = "configuration";
async function main() {
  const config = developmentConfig(
    protectedEnvironment(resolve(root, ".env.local")),
    protectedEnvironment(resolve(root, ".env.dashboard.local")),
  );
  const origin = config.DASHBOARD_ORIGIN!;
  if (origin !== "http://127.0.0.1:5173")
    throw new Error("Smoke check expects localhost development");
  stage = "session login";
  const session = await fetch(origin + "/api/session", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ password: config.DASHBOARD_PASSWORD }),
    signal: AbortSignal.timeout(5000),
  });
  if (session.status !== 200) throw new Error("Login failed");
  const cookie = session.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("No session cookie");
  const headers = { cookie };
  async function get<T>(
    path: string,
    schema: { parse(value: unknown): T },
  ): Promise<T> {
    const response = await fetch(origin + path, {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(65000),
    });
    if (!response.ok) throw new Error("Read request failed");
    return schema.parse(await response.json());
  }
  const before = new Date(),
    after = new Date(before.getTime() - 30 * 86400000);
  stage = "statistics";
  const statistics = await get(
    "/api/dashboard/statistics?" +
      new URLSearchParams({
        occurredAfter: after.toISOString(),
        occurredBefore: before.toISOString(),
      }),
    statisticsSchema,
  );
  stage = "event pagination";
  const first = await get("/api/events?limit=30", pageSchema);
  if (!first.nextCursor || first.events.length !== 30)
    throw new Error("Pagination cohort unavailable");
  const second = await get(
    "/api/events?limit=30&cursor=" + encodeURIComponent(first.nextCursor),
    pageSchema,
  );
  if (second.events.some((e) => first.events.some((f) => e.id === f.id)))
    throw new Error("Pagination overlap");
  const candidate = [...first.events, ...second.events].find((e) =>
    e.objects.some((o) => o.images.cropId && o.images.fullFrameId),
  );
  if (!candidate)
    throw new Error("No image-associated event in bounded cohort");
  stage = "event detail";
  const event = await get("/api/events/" + candidate.id, eventSchema),
    object = event.objects.find(
      (o) => o.images.cropId && o.images.fullFrameId,
    )!;
  const images = [object.images.cropId, object.images.fullFrameId].map((id) =>
    event.images.find((image) => image.id === id)!,
  );
  if (images.some((image) => !image?.url))
    throw new Error("Original references missing");
  stage = "original images and unchanged reference metadata";
  const database = new pg.Client({
    connectionString: readOnlyConnectionString(config.DATABASE_URL),
    connectionTimeoutMillis: 3000,
  });
  await database.connect();
  try {
    const query = `SELECT id,"referenceVersion","referenceStatus","referenceCheckedAt","referenceResolvedAt","referenceVerifiedAt","referenceFailureCode" FROM "EventSnapshot" WHERE id=ANY($1::uuid[]) ORDER BY id`;
    const baseline = await database.query(query, [
      images.map((image) => image.id),
    ]);
    for (const image of images) {
      const response = await fetch(origin + image.url!, {
        headers,
        cache: "no-store",
        signal: AbortSignal.timeout(65000),
      });
      if (
        !response.ok ||
        !response.headers.get("content-type")?.startsWith("image/jpeg")
      )
        throw new Error("Original image unavailable");
      const bytes = Buffer.from(await response.arrayBuffer());
      // SHA-256 is intentionally not printed, nor are bytes or source metadata.
      const metadata = await database.query<{ sha256: string }>(
        'SELECT sha256 FROM "EventSnapshot" WHERE id=$1::uuid',
        [image.id],
      );
      if (
        createHash("sha256").update(bytes).digest("hex") !==
        metadata.rows[0]?.sha256
      )
        throw new Error("Original image hash mismatch");
    }
    const unchanged = await database.query(query, [
      images.map((image) => image.id),
    ]);
    if (JSON.stringify(baseline.rows) !== JSON.stringify(unchanged.rows))
      throw new Error("Reference metadata changed; stop development");
  } finally {
    await database.end();
  }
  stage = "camera and zone metadata";
  const cameras = await get("/api/cameras", camerasSchema);
  let zoneCount = 0;
  for (const camera of cameras.cameras) {
    const zones = await get(
      `/api/cameras/${encodeURIComponent(camera.id)}/zones`,
      zonesSchema,
    );
    zoneCount += zones.zones.length;
    await get(
      `/api/cameras/${encodeURIComponent(camera.id)}/streams`,
      streamsSchema,
    );
  }
  const logout = await fetch(origin + "/api/session", {
    method: "DELETE",
    headers: { ...headers, origin },
    signal: AbortSignal.timeout(5000),
  });
  if (logout.status !== 200) throw new Error("Logout failed");
  process.stdout.write(
    JSON.stringify({
      login: 200,
      statistics: 200,
      canonicalEvents30Days: statistics.total,
      pages: [first.events.length, second.events.length],
      paginationOverlap: false,
      detail: 200,
      originalCrop: "hash verified in RAM",
      originalFullFrame: "hash verified in RAM",
      referenceMetadata: "unchanged",
      cameras: cameras.cameras.length,
      zoneSlots: zoneCount,
      streams: "validated",
      logout: 200,
    }) + "\n",
  );
}
void main().catch(() => {
  process.stderr.write(
    `Development smoke check failed at ${stage}. No response bodies, credentials or media were logged. Stop and inspect before retrying.\n`,
  );
  process.exitCode = 1;
});
