import { readFileSync, statSync } from "node:fs";
import { parse } from "dotenv";
import type { Plugin } from "vite";
import { attachLiveProxy, type LiveProxyOptions } from "../edge/live-proxy.js";
export { liveSource, mseRequest, mseResponse } from "../edge/live-proxy.js";
export type { LiveProxyOptions } from "../edge/live-proxy.js";

export function localLiveOptions(origin: string, useConfiguredOrigin = true): LiveProxyOptions {
  const file = new URL("../../.env.dashboard.local", import.meta.url);
  const mode = statSync(file).mode;
  if ((mode & 0o077) !== 0) throw new Error("Development environment requires mode 600");
  const env = parse(readFileSync(file));
  const enabled = env.LIVE_GATEWAY_ENABLED === "true";
  if (enabled && (!env.SECURITY_GATEWAY_USER || !env.SECURITY_GATEWAY_PASSWORD ||
      env.SECURITY_GATEWAY_USER.includes(":") || /[\r\n]/.test(env.SECURITY_GATEWAY_USER + env.SECURITY_GATEWAY_PASSWORD)))
    throw new Error("Set server-only gateway credentials before enabling live viewing");
  return { origin: useConfiguredOrigin ? env.DASHBOARD_ORIGIN ?? origin : origin, enabled, authorization: "Basic " + Buffer.from(
    `${env.SECURITY_GATEWAY_USER ?? ""}:${env.SECURITY_GATEWAY_PASSWORD ?? ""}`,
  ).toString("base64") };
}

export function liveProxy(options: LiveProxyOptions): Plugin {
  return {
    name: "authenticated-local-live",
    configureServer(server) {
      if (server.httpServer) attachLiveProxy(server.httpServer, options);
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/api/live/")) return next();
        if (req.url.startsWith("/api/live/authorize?")) return next();
        res.writeHead(404).end();
      });
    },
  };
}
