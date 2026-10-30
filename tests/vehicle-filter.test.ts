import { expect, it, vi } from "vitest";
import { historySchema } from "../src/events/queries.js";
import { createEventQueries, historyFilters } from "../src/events/store.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
it("filters grouped AI vehicle types on the same source object before cursor pagination", async () => {
  const query = historySchema.parse({
    vehicleGroup: "car",
    category: "motor_vehicle",
    action: "visible",
    limit: 30,
  });
  const filter = historyFilters(query)
      .map((q) => q.sql)
      .join(" "),
    values = historyFilters(query).flatMap((q) => q.values);
  expect(values).toContain("car");
  expect(values).toContain("suv");
  expect(values).toContain("MOTOR_VEHICLE");
  expect(filter).toContain('ai."objectId"=o.id');
  expect(filter).toContain('ai."eventId"=o."eventId"');
  expect(filter).toContain("subject->>'objectId'=o.id::text");
  expect(filter).toContain("ai.verification<>'contradicted'");
  expect(filter).toContain('a."objectId"=o.id');
  const raw = vi.fn(async () => []),
    findMany = vi.fn(async () => []);
  await createEventQueries({
    $queryRaw: raw, univiewZoneVersion:{findMany:async()=>[]},
    securityEvent: { findMany },
  } as unknown as PrismaClient).history(query);
  const statement = (
    raw.mock.calls[0] as unknown as [{ sql: string; values: unknown[] }]
  )[0];
  expect(statement.sql.indexOf("jsonb_array_elements")).toBeLessThan(
    statement.sql.indexOf("ORDER BY COALESCE"),
  );
  expect(statement.values.at(-1)).toBe(31);
});
it("supports only the actual grouped vocabulary and composes without requiring source filters", () => {
  for (const vehicleGroup of [
    "car",
    "van",
    "truck",
    "bus",
    "motorcycle",
    "bicycle",
  ])
    expect(historyFilters(historySchema.parse({ vehicleGroup })).length).toBe(
      1,
    );
  for (const vehicleGroup of ["lorry", "suv", "other", "unknown", "person"])
    expect(historySchema.safeParse({ vehicleGroup }).success).toBe(false);
});
