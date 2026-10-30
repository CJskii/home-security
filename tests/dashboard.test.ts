import { afterEach, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import {
  createStatistics,
  statisticsSchema,
} from "../src/dashboard/statistics.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
const origin = "http://localhost:5173",
  password = "dashboard-password-".repeat(3);
const instances: ReturnType<typeof buildApp>[] = [];
afterEach(async () => {
  await Promise.all(instances.splice(0).map((s) => s.app.close()));
});
function setup(secure = false) {
  const config = loadConfig({
    DATABASE_URL: "postgresql://test:secret@invalid/security",
    LOG_LEVEL: "silent",
    EVENTS_TOKEN: "e".repeat(32),
    DASHBOARD_ORIGIN: secure ? "https://security.example" : origin,
    DASHBOARD_PASSWORD: password,
    DASHBOARD_SESSION_KEY: "ab".repeat(32),
  });
  const statistics = vi.fn(async () => ({
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
  }));
  const service = buildApp(config, {
    statistics,
    checkReady: vi.fn(),
    disconnect: vi.fn(),
  });
  instances.push(service);
  return { ...service, statistics };
}
it("logs in with an HttpOnly same-site cookie, scopes read access, logs out and preserves bearer access", async () => {
  const f = setup();
  expect((await f.app.inject("/api/dashboard/statistics")).statusCode).toBe(
    401,
  );
  const login = await f.app.inject({
    method: "POST",
    url: "/api/session",
    headers: { origin },
    payload: { password },
  });
  expect(login.statusCode).toBe(200);
  const cookie = login.cookies[0]!;
  expect(cookie.httpOnly).toBe(true);
  expect(cookie.sameSite).toBe("Strict");
  expect(cookie.path).toBe("/api");
  const headers = {
    cookie: `${cookie.name}=${encodeURIComponent(cookie.value)}`,
  };
  const url =
    "/api/dashboard/statistics?occurredAfter=2026-10-18T00:00:00Z&occurredBefore=2026-10-19T00:00:00Z";
  expect((await f.app.inject({ url, headers })).statusCode).toBe(200);
  expect((await f.app.inject({ url, headers: { ...headers, 'sec-fetch-site': 'same-site' } })).statusCode).toBe(401);
  expect(
    (
      await f.app.inject({
        url,
        headers: { ...headers, origin: "https://evil.example" },
      })
    ).statusCode,
  ).toBe(401);
  expect(
    (
      await f.app.inject({
        method: "POST",
        url: "/api/events/17b01e57-cc3d-4db5-9bdd-f7d89e8149bb/enrich",
        headers,
      })
    ).statusCode,
  ).toBe(401);
  expect(
    (
      await f.app.inject({
        url,
        headers: { authorization: "Bearer " + "e".repeat(32) },
      })
    ).statusCode,
  ).toBe(200);
  const logout = await f.app.inject({
    method: "DELETE",
    url: "/api/session",
    headers: { ...headers, origin },
  });
  expect(logout.statusCode).toBe(200);
  expect(logout.cookies[0]?.value).toBe("");
});
it("rejects foreign/missing origins, incorrect passwords, tampered sessions and limits guesses", async () => {
  const f = setup();
  for (const headers of [{}, { origin: "https://evil.example" }])
    expect(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/session",
          headers,
          payload: { password },
        })
      ).statusCode,
    ).toBe(403);
  for (let i = 0; i < 3; i++)
    expect(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/session",
          headers: { origin },
          payload: { password: "wrong" },
        })
      ).statusCode,
    ).toBe(401);
  expect(
    (
      await f.app.inject({
        method: "POST",
        url: "/api/session",
        headers: { origin },
        payload: { password },
      })
    ).statusCode,
  ).toBe(429);
  expect(
    (
      await f.app.inject({
        url: "/api/session",
        headers: { cookie: "dashboard_session=tampered" },
      })
    ).statusCode,
  ).toBe(401);
});
it("uses Secure cookies for HTTPS and rejects incomplete or insecure production configuration", async () => {
  const f = setup(true);
  const response = await f.app.inject({
    method: "POST",
    url: "/api/session",
    headers: { origin: "https://security.example" },
    payload: { password },
  });
  expect(response.cookies[0]?.secure).toBe(true);
  expect(() =>
    loadConfig({
      DATABASE_URL: "postgresql://test:secret@invalid/security",
      DASHBOARD_ORIGIN: origin,
    }),
  ).toThrow();
  expect(() =>
    loadConfig({
      DATABASE_URL: "postgresql://test:secret@invalid/security",
      NODE_ENV: "production",
      DASHBOARD_ORIGIN: origin,
      DASHBOARD_PASSWORD: password,
      DASHBOARD_SESSION_KEY: "ab".repeat(32),
    }),
  ).toThrow();
});
it("validates bounded statistics ranges and returns aggregate counts without event hydration", async () => {
  const q = statisticsSchema.parse({
    camera: "camera'1",
    occurredAfter: "2026-10-18T00:00:00Z",
    occurredBefore: "2026-10-19T00:00:00Z",
  });
  const query = vi.fn(async () => [
    {
      start: q.occurredAfter,
      total: 2n,
      person: 2n,
      motorVehicle: 1n,
      complete: 1n,
      skipped: 1n,
      failed: 0n,
      interrupted: 0n,
      pending: 0n,
      missing: 0n,
    },
  ]);
  const result = await createStatistics({
    $queryRaw: query,
  } as unknown as PrismaClient)(q);
  expect(result).toMatchObject({
    total: 2,
    person: 2,
    motorVehicle: 1,
    completionPercentage: 50,
  });
  expect(result.activity[0]?.count).toBe(2);
  expect(result.activity[1]?.count).toBe(0);
  const sql = (
    query.mock.calls[0] as unknown as [{ sql: string; values: unknown[] }]
  )[0];
  expect(sql.sql).not.toContain("camera'1");
  expect(sql.values).toContain("camera'1");
  expect(sql.sql).toContain(
    'COALESCE(e."occurredAt",s."reportedAt",e."firstReceivedAt")',
  );
  expect(sql.sql).toContain("EXISTS");
  expect(
    statisticsSchema.safeParse({
      occurredAfter: "2026-01-01T00:00:00Z",
      occurredBefore: "2026-10-19T00:00:00Z",
    }).success,
  ).toBe(false);
});
it("disables browser authentication when not configured", async () => {
  const f = buildApp(
    loadConfig({
      DATABASE_URL: "postgresql://test:secret@invalid/security",
      LOG_LEVEL: "silent",
    }),
    { checkReady: vi.fn(), disconnect: vi.fn() },
  );
  instances.push(f);
  expect((await f.app.inject("/api/session")).statusCode).toBe(404);
});

it('reports invalid origins safely and treats empty optional settings as disabled', () => {
  expect(() => loadConfig({ DATABASE_URL: 'postgresql://test:secret@invalid/security', DASHBOARD_ORIGIN: 'malformed-private-value' })).toThrow('Invalid configuration fields: DASHBOARD_ORIGIN');
  expect(loadConfig({ DATABASE_URL: 'postgresql://test:secret@invalid/security', DASHBOARD_ORIGIN: '', DASHBOARD_PASSWORD: '', DASHBOARD_SESSION_KEY: '' }).DASHBOARD_ORIGIN).toBeUndefined();
});

it("gates live sources with the exact Origin and session, without bearer bypass or data access", async () => {
  const config = loadConfig({
    DATABASE_URL: "postgresql://test:secret@invalid/security",
    LOG_LEVEL: "silent", EVENTS_TOKEN: "e".repeat(32),
    DASHBOARD_ORIGIN: origin, DASHBOARD_PASSWORD: password,
    DASHBOARD_SESSION_KEY: "ab".repeat(32), LIVE_GATEWAY_ENABLED: "true",
    UNIVIEW_CAMERA_MAP: '{"1":"camera_1","2":"camera_2"}',
  });
  const f = buildApp(config, { checkReady: vi.fn(), disconnect: vi.fn() });
  instances.push(f);
  const login = await f.app.inject({ method: "POST", url: "/api/session", headers: { origin }, payload: { password } });
  const cookie = login.headers["set-cookie"]!.toString().split(";")[0]!;
  const url = "/api/live/authorize?src=camera_1_sub";
  expect((await f.app.inject({ url, headers: { origin, cookie } })).statusCode).toBe(200);
  expect((await f.app.inject({ url: url.replace("1_sub", "2_sub"), headers: { origin, cookie } })).statusCode).toBe(200);
  expect((await f.app.inject({ url, headers: { origin, authorization: "Bearer " + "e".repeat(32) } })).statusCode).toBe(401);
  for (const headers of [{ cookie }, { cookie, origin: "https://evil.test" }, { cookie, origin, "sec-fetch-site": "cross-site" }])
    expect((await f.app.inject({ url, headers })).statusCode).toBe(403);
  for (const query of ["src=camera_1_main", "src=rtsp://private", "src=camera_1_sub&extra=1", "src=camera_1_sub&src=camera_2_sub"])
    expect((await f.app.inject({ url: "/api/live/authorize?" + query, headers: { origin, cookie } })).statusCode).toBe(400);
  expect((await f.app.inject({ url, headers: { origin, cookie: "dashboard_session=tampered" } })).statusCode).toBe(401);
  const disabled = setup();
  expect((await disabled.app.inject({ url, headers: { origin, cookie } })).statusCode).toBe(503);
});
