// @vitest-environment node
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createDashboardServer, productionOptions } from "../../edge/server.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "security-edge-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "index.html"), "<html>dashboard</html>");
  await writeFile(join(root, "assets", "app-abc123.js"), "export const dashboard = true;");
  const calls: { url: string; origin?: string; cookie?: string; forwarded?: string }[] = [];
  const api = createServer((req, res) => {
    calls.push({ url: req.url!, origin: req.headers.origin, cookie: req.headers.cookie, forwarded: req.headers["x-forwarded-for"] as string | undefined });
    res.writeHead(200, { "Cache-Control": "no-store", "Set-Cookie": "dashboard_session=fixture; Path=/api; HttpOnly; Secure; SameSite=Strict" });
    req.pipe(res);
  });
  await new Promise<void>(resolve => api.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>(resolve => { api.closeAllConnections(); api.close(() => resolve()); }));
  const { server, stopLive } = createDashboardServer({ origin: "https://security.test", assets: root, enabled: false,
    authorization: "", apiOrigin: `http://127.0.0.1:${(api.address() as AddressInfo).port}` });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>(resolve => { stopLive(); server.closeAllConnections(); server.close(() => resolve()); }));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, calls };
}
it("serves built assets and SPA routes with appropriate caching, without exposing private files", async () => {
  const { base } = await fixture();
  const spa = await fetch(base + "/explore?camera=one");
  expect(await spa.text()).toBe("<html>dashboard</html>");
  expect(spa.headers.get("cache-control")).toBe("no-cache");
  const asset = await fetch(base + "/assets/app-abc123.js");
  expect(asset.headers.get("cache-control")).toContain("immutable");
  expect(asset.headers.get("content-type")).toContain("javascript");
  for (const path of ["/.env", "/.git/config", "/%2eenv", "/internal", "/internal/refresh", "/metrics", "/missing.js", "/api/live/authorize?src=camera_1_sub", "/api/live/config"]) {
    expect((await fetch(base + path)).status, path).toBe(404);
  }
  expect((await fetch(base + "/explore", { method: "POST" })).status).toBe(405);
});
it("streams session/API and signed-media requests while preserving cookies, origin, queries and no-store", async () => {
  const { base, calls } = await fixture();
  const response = await fetch(base + "/api/session", { method: "POST", body: '{"password":"fixture"}',
    headers: { origin: "https://security.test", cookie: "existing=fixture", "x-forwarded-for": "forged", "content-type": "application/json" } });
  expect(await response.text()).toBe('{"password":"fixture"}');
  expect(response.headers.get("set-cookie")).toContain("HttpOnly; Secure; SameSite=Strict");
  expect(response.headers.get("cache-control")).toBe("no-store");
  await fetch(base + "/api/notification-media/fixture?token=fixture");
  expect(calls).toEqual([
    { url: "/api/session", origin: "https://security.test", cookie: "existing=fixture", forwarded: undefined },
    { url: "/api/notification-media/fixture?token=fixture", origin: undefined, cookie: undefined, forwarded: undefined },
  ]);
});
it("rejects absolute-form and protocol-relative proxy targets", async () => {
  const { base, calls } = await fixture();
  for (const path of ["http://127.0.0.1:1/api/events", "//127.0.0.1:1/api/events"]) {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(base, { path }, res => { res.resume(); resolve(res.statusCode!); });
      req.on("error", reject); req.end();
    });
    expect(status).toBe(400);
  }
  expect(calls).toHaveLength(0);
});
it("validates server-only origins and never accepts URL credentials or insecure browser origins", () => {
  const env = { DASHBOARD_ORIGIN: "https://security.test", DASHBOARD_API_ORIGIN: "http://api:3000" };
  expect(productionOptions(env).enabled).toBe(false);
  for (const changes of [{ DASHBOARD_ORIGIN: "http://security.test" },
    { DASHBOARD_API_ORIGIN: "http://user:secret@api:3000" },
    { DASHBOARD_API_ORIGIN: "http://api:3000/private" },
    { LIVE_GATEWAY_ENABLED: "true" },
    { LIVE_GATEWAY_ENABLED: "true", SECURITY_GATEWAY_ORIGIN: "http://gateway:1984", SECURITY_GATEWAY_USER: "user", SECURITY_GATEWAY_PASSWORD: "bad\r\nsecret" }])
    expect(() => productionOptions({ ...env, ...changes })).toThrow();
});
