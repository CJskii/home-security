import {developmentDeliveryClient} from './development-delivery.js';
import { developmentNotificationWriter } from './development-notifications.js';
import { developmentProcessingProposalWriter } from './development-processing-proposal.js';
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { buildApp } from "../app.js";
import type { Database } from "../database.js";
import type { Config } from "../config.js";
import { createShutdown } from "../lifecycle.js";
import { createDevelopmentDatabase } from "./development-database.js";
import {
  developmentConfig,
  protectedEnvironment,
} from "./development-config.js";
import { createDevelopmentMedia } from "./development-media.js";
import type { NvrApi } from "../events/nvr-service.js";
import { developmentPreferenceWriter } from './development-zone-preferences.js';
export function buildDevelopmentApp(
  config: Config,
  database: Database,
  media?: NvrApi,
) {
  if (
    config.AI_ENABLED ||
    config.AI_ZONE_SELECTION_ENABLED ||
    config.UNIVIEW_ENABLED ||
    config.METRICS_ENABLED ||
    config.EVENTS_TOKEN
  )
    throw new Error("Unsafe development configuration");
  if (!database.historicalImages)
    throw new Error("Missing read-only image store");
  const service = buildApp(
    config,
    database,
    undefined,
    media ?? createDevelopmentMedia(config, database.historicalImages),
    undefined,
  );
  service.app.addHook("onRequest", async (request, reply) => {
    if (
      !["GET", "HEAD"].includes(request.method) &&
      !(database.notificationDelivery && ((request.method==='PUT'&&request.routeOptions.url==='/api/notifications/delivery/settings')||(request.method==='POST'&&['/api/notifications/delivery/preview','/api/notifications/delivery/test'].includes(request.routeOptions.url??'')))) &&
      !(database.notifications && request.method==='POST' && request.routeOptions.url==='/api/notifications/preview') &&
      !(database.notifications?.save && request.method==='PUT' && request.routeOptions.url==='/api/notifications/settings') &&
      !(database.notifications?.archive && request.method==='POST' && request.routeOptions.url==='/api/notifications/evaluations') &&
      !(database.processingProposal?.save && request.method==='PUT' && request.routeOptions.url==='/api/ai/processing') &&
      !(database.zonePreferences?.save && request.method === 'PATCH' && request.routeOptions.url === '/api/cameras/:id/zones/:zoneId/preferences') &&
      !(config.CAMERA_SYNC_OWNER_URL && request.method === 'POST' && ['/api/cameras/configuration/refresh','/api/cameras/zones/refresh'].includes(request.routeOptions.url ?? '')) &&
      !(
        request.routeOptions.url === "/api/session" &&
        ["POST", "DELETE"].includes(request.method)
      )
    )
      return reply.code(405).send({ error: "Development API is read-only" });
  });
  return service;
}
async function main() {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const source = protectedEnvironment(resolve(root, ".env.local"));
  const config = developmentConfig(
    source,
    protectedEnvironment(resolve(root, ".env.dashboard.local")),
    process.env.DASHBOARD_DEV_LAN === "true",
  );
  const database = createDevelopmentDatabase(config, developmentPreferenceWriter(config, source.EVENTS_TOKEN),developmentProcessingProposalWriter(config,source.EVENTS_TOKEN),developmentNotificationWriter(config,source.EVENTS_TOKEN),developmentDeliveryClient(config,source.EVENTS_TOKEN));
  try {
    await database.checkReady();
  } catch {
    await database.disconnect();
    throw new Error(
      "Read-only target verification failed; development API not started",
    );
  }
  const service = buildDevelopmentApp(config, database);
  const shutdown = createShutdown({
    app: service.app,
    markStopping: service.markStopping,
    timeoutMs: 10000,
    exit: (code) => process.exit(code),
  });
  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  try {
    await service.app.listen({ host: config.HOST, port: config.PORT });
  } catch {
    await shutdown("listen_failure");
    throw new Error("Development API could not bind its separate port");
  }
}
if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url))
  void main().catch(() => {
    process.stderr.write(JSON.stringify({
      level: 60, time: new Date().toISOString(), service: "home-security-dashboard-dev", environment: "development",
      errorCode: "DEVELOPMENT_STARTUP_FAILED",
      msg: "Development API could not start safely. Check protected environment files, database reachability, read-only settings and port 3001.",
    }) + "\n");
    process.exitCode = 1;
  });
