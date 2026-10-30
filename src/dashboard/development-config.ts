import { readFileSync, statSync } from "node:fs";
import { parse } from "dotenv";
import { z } from "zod";
import { loadConfig, type Config } from "../config.js";
export function protectedEnvironment(path: string): Record<string, string> {
  const stat = statSync(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0)
    throw new Error("Development environment files require mode 600");
  return parse(readFileSync(path));
}
export function developmentConfig(
  source: Record<string, string>,
  local: Record<string, string>,
  lan = false,
): Config {
  const host = z.ipv4().safeParse(local.DEV_DATABASE_HOST);
  if (!host.success || !source.DATABASE_URL)
    throw new Error("Run npm run dev:setup before starting development");
  const url = new URL(source.DATABASE_URL);
  if (url.pathname !== "/security_events" || (url.port && url.port !== "5432"))
    throw new Error("Unexpected development database target");
  url.hostname = host.data;
  const selected = Object.fromEntries(
    [
      "UNIVIEW_INSTALLATION_ID",
      "UNIVIEW_NVR_IP",
      "UNIVIEW_USERNAME",
      "UNIVIEW_PASSWORD",
      "UNIVIEW_CAMERA_MAP",
    ].flatMap((key) => (source[key] ? [[key, source[key]]] : [])),
  );
  return loadConfig({
    ...selected,
    NODE_ENV: "development",
    HOST: "127.0.0.1",
    PORT: "3001",
    SERVICE_NAME: "home-security-dashboard-dev",
    DATABASE_URL: url.toString(),
    LOG_LEVEL: "info",
    DB_POOL_MAX: "2",
    UNIVIEW_ENABLED: "false",
    UNIVIEW_SAMPLING_ENABLED: "false",
    AI_ENABLED: "false",
    METRICS_ENABLED: "false",
    CAMERA_SYNC_OWNER_URL: local.CAMERA_SYNC_OWNER_URL,
    CAMERA_SYNC_TOKEN: local.CAMERA_SYNC_TOKEN,
    LIVE_GATEWAY_ENABLED: local.LIVE_GATEWAY_ENABLED ?? "false",
    DASHBOARD_ORIGIN: lan
      ? `https://${z.ipv4().parse(local.DEV_LAN_IP)}:5173`
      : (local.DASHBOARD_ORIGIN ?? "http://127.0.0.1:5173"),
    DASHBOARD_PASSWORD: local.DASHBOARD_PASSWORD,
    DASHBOARD_SESSION_KEY: local.DASHBOARD_SESSION_KEY,
  });
}
