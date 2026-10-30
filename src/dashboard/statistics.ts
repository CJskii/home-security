import { z } from "zod";
import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
export const statisticsSchema = z
  .object({
    camera: z.string().min(1).max(128).optional(),
    occurredAfter: z.iso
      .datetime({ offset: true })
      .transform((v) => new Date(v)),
    occurredBefore: z.iso
      .datetime({ offset: true })
      .transform((v) => new Date(v)),
  })
  .strict()
  .refine(
    (q) =>
      q.occurredBefore > q.occurredAfter &&
      q.occurredBefore.getTime() - q.occurredAfter.getTime() <= 31 * 86400000,
  );
export type StatisticsQuery = z.infer<typeof statisticsSchema>;
export interface Statistics {
  total: number;
  person: number;
  motorVehicle: number;
  complete: number;
  skipped: number;
  failed: number;
  interrupted: number;
  pending: number;
  missing: number;
  completionPercentage: number;
  activity: { start: string; count: number }[];
}
interface Bucket {
  start: Date;
  total: bigint;
  person: bigint;
  motorVehicle: bigint;
  complete: bigint;
  skipped: bigint;
  failed: bigint;
  interrupted: bigint;
  pending: bigint;
  missing: bigint;
}
export function createStatistics(prisma: PrismaClient) {
  return async (q: StatisticsQuery): Promise<Statistics> => {
    const seconds =
      q.occurredBefore.getTime() - q.occurredAfter.getTime() <= 86400000
        ? 3600
        : 86400;
    // EXISTS counts canonical events once per category; mixed events intentionally overlap.
    // Source-time fallback is identical to history. One statement gives a consistent snapshot.
    const rows = await prisma.$queryRaw<Bucket[]>(Prisma.sql`
      WITH cohort AS (
        SELECT e.id, COALESCE(e."occurredAt",s."reportedAt",e."firstReceivedAt") AS time, p.status,
          EXISTS(SELECT 1 FROM "UniviewObject" o WHERE o."eventId"=e.id AND o.category='PERSON') AS person,
          EXISTS(SELECT 1 FROM "UniviewObject" o WHERE o."eventId"=e.id AND o.category='MOTOR_VEHICLE') AS vehicle
        FROM "SecurityEvent" e
        LEFT JOIN "EvidenceProcessing" p ON p."eventId"=e.id
        LEFT JOIN LATERAL (SELECT n."reportedAt" FROM "UniviewNotification" n WHERE n."eventId"=e.id
          AND n.kind='STRUCTURE'::"NotificationKind" AND n."reportedAt" IS NOT NULL ORDER BY n."reportedAt",n.id LIMIT 1) s ON true
        WHERE COALESCE(e."occurredAt",s."reportedAt",e."firstReceivedAt") >= ${q.occurredAfter}
          AND COALESCE(e."occurredAt",s."reportedAt",e."firstReceivedAt") <= ${q.occurredBefore}
          ${q.camera ? Prisma.sql`AND e.camera=${q.camera}` : Prisma.empty}
      ) SELECT date_bin(${`${seconds} seconds`}::interval,time,${q.occurredAfter}::timestamptz) AS start,
        count(*) AS total, count(*) FILTER(WHERE person) AS person, count(*) FILTER(WHERE vehicle) AS "motorVehicle",
        count(*) FILTER(WHERE status='COMPLETE') AS complete, count(*) FILTER(WHERE status='SKIPPED') AS skipped,
        count(*) FILTER(WHERE status='FAILED') AS failed, count(*) FILTER(WHERE status='INTERRUPTED') AS interrupted,
        count(*) FILTER(WHERE status IN ('COLLECTING','ANALYSING')) AS pending, count(*) FILTER(WHERE status IS NULL) AS missing
      FROM cohort GROUP BY start ORDER BY start`);
    const result: Statistics = {
      total: 0,
      person: 0,
      motorVehicle: 0,
      complete: 0,
      skipped: 0,
      failed: 0,
      interrupted: 0,
      pending: 0,
      missing: 0,
      completionPercentage: 0,
      activity: [],
    };
    for (const row of rows)
      for (const key of [
        "total",
        "person",
        "motorVehicle",
        "complete",
        "skipped",
        "failed",
        "interrupted",
        "pending",
        "missing",
      ] as const)
        result[key] += Number(row[key]);
    result.completionPercentage = result.total
      ? Math.round((result.complete / result.total) * 1000) / 10
      : 0;
    const buckets = new Map(
      rows.map((r) => [r.start.toISOString(), Number(r.total)]),
    );
    for (
      let t = q.occurredAfter.getTime();
      t <= q.occurredBefore.getTime();
      t += seconds * 1000
    )
      result.activity.push({
        start: new Date(t).toISOString(),
        count: buckets.get(new Date(t).toISOString()) ?? 0,
      });
    return result;
  };
}
