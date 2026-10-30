import { createHash, timingSafeEqual } from "node:crypto";
import secureSession from "@fastify/secure-session";
import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";

declare module "@fastify/secure-session" {
  interface SessionData {
    dashboard: boolean;
  }
}
// One operator session; event access stays read-only. Configuration refresh has
// its own narrowly scoped mutation/origin gate. Bearer clients retain their contract.
export function installDashboardSession(app: FastifyInstance, config: Config) {
  const origin = config.DASHBOARD_ORIGIN;
  if (!origin || !config.DASHBOARD_PASSWORD || !config.DASHBOARD_SESSION_KEY)
    return () => false;
  const digest = (v: string) => createHash("sha256").update(v).digest();
  const expected = digest(config.DASHBOARD_PASSWORD);
  void app.register(secureSession, {
    key: Buffer.from(config.DASHBOARD_SESSION_KEY, "hex"),
    cookieName: "dashboard_session",
    expiry: 28800,
    cookie: {
      path: "/api",
      httpOnly: true,
      secure: origin.startsWith("https:"),
      sameSite: "strict",
      maxAge: 28800,
    },
  });
  void app.register(rateLimit, {
    global: false,
    max: 5,
    timeWindow: "1 minute",
  });
  const allowed = (req: FastifyRequest) =>
    req.headers.origin === origin &&
    req.headers["sec-fetch-site"] !== "cross-site";
  app.after(() => {
    // A control-only gate for the development WebSocket edge. No bearer bypass,
    // forwarded URL trust, media bytes or gateway credentials are involved.
    app.get("/api/live/authorize", {
      schema: { querystring: z.object({
        src: z.enum(["camera_1_sub", "camera_2_sub"]),
      }).strict() },
    }, async (req, reply) => {
      reply.header("Cache-Control", "no-store");
      if (!allowed(req)) return reply.code(403).send({ error: "Forbidden" });
      if (req.session.get("dashboard") !== true)
        return reply.code(401).send({ error: "Unauthorized" });
      const { src } = req.query as { src: string };
      if (!config.LIVE_GATEWAY_ENABLED)
        return reply.code(503).send({ error: "Live viewing is not configured" });
      if (!config.UNIVIEW_CAMERA_MAP[src.split("_")[1]!])
        return reply.code(404).send({ error: "Not found" });
      return { authorized: true };
    });
    app.post(
      "/api/session",
      {
        config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
        schema: {
          body: z.object({ password: z.string().min(1).max(256) }).strict(),
          querystring: z.object({}).strict(),
        },
      },
      async (req, reply) => {
        if (!allowed(req)) return reply.code(403).send({ error: "Forbidden" });
        const { password } = req.body as { password: string };
        if (!timingSafeEqual(expected, digest(password)))
          return reply.code(401).send({ error: "Unauthorized" });
        req.session.regenerate();
        req.session.set("dashboard", true);
        return { authenticated: true };
      },
    );
    app.get(
      "/api/session",
      { schema: { querystring: z.object({}).strict() } },
      async (req, reply) => {
        return req.session.get("dashboard") === true
          ? { authenticated: true }
          : reply.code(401).send({ error: "Unauthorized" });
      },
    );
    app.delete(
      "/api/session",
      { schema: { querystring: z.object({}).strict() } },
      async (req, reply) => {
        if (!allowed(req)) return reply.code(403).send({ error: "Forbidden" });
        req.session.delete();
        return { authenticated: false };
      },
    );
  });
  return (req: FastifyRequest) =>
    (req.headers["sec-fetch-site"] === undefined ||
      ["same-origin", "none"].includes(
        String(req.headers["sec-fetch-site"]),
      )) &&
    (!req.headers.origin || req.headers.origin === origin) &&
    req.session?.get("dashboard") === true;
}
