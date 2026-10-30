import { createServer, request, type IncomingHttpHeaders } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { pipeline } from "node:stream";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { attachLiveProxy, type LiveProxyOptions } from "./live-proxy.js";

const upstream = z.string().url().refine((value) => {
  const u = new URL(value);
  return u.protocol === "http:" && !u.username && !u.password && u.pathname === "/" && !u.search && !u.hash;
});
export function productionOptions(env: NodeJS.ProcessEnv) {
  const config = z.object({
    DASHBOARD_ORIGIN: z.string().url().refine((v) => new URL(v).origin === v && v.startsWith("https://")),
    DASHBOARD_API_ORIGIN: upstream,
    LIVE_GATEWAY_ENABLED: z.enum(["true", "false"]).default("false"),
    SECURITY_GATEWAY_ORIGIN: upstream.optional(),
    SECURITY_GATEWAY_USER: z.string().min(1).refine(v => !/[:\r\n]/.test(v)).optional(),
    SECURITY_GATEWAY_PASSWORD: z.string().min(1).refine(v => !/[\r\n]/.test(v)).optional(),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  }).parse(env);
  const enabled = config.LIVE_GATEWAY_ENABLED === "true";
  if (enabled && (!config.SECURITY_GATEWAY_ORIGIN || !config.SECURITY_GATEWAY_USER || !config.SECURITY_GATEWAY_PASSWORD))
    throw new Error("Server-only gateway configuration required");
  return { port: config.PORT, origin: config.DASHBOARD_ORIGIN, apiOrigin: config.DASHBOARD_API_ORIGIN,
    enabled, gatewayOrigin: config.SECURITY_GATEWAY_ORIGIN?.replace(/^http:/, "ws:"),
    authorization: enabled ? "Basic " + Buffer.from(`${config.SECURITY_GATEWAY_USER}:${config.SECURITY_GATEWAY_PASSWORD}`).toString("base64") : "" };
}
const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2" };
function proxyHeaders(input: IncomingHttpHeaders): IncomingHttpHeaders {
  const headers = { ...input };
  const connection = String(headers.connection ?? "").split(",").map(v => v.trim().toLowerCase());
  for (const name of [...connection, "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"])
    delete headers[name];
  return headers;
}
export function createDashboardServer(options: LiveProxyOptions & { apiOrigin: string; assets: string }) {
  const root = resolve(options.assets);
  const server = createServer((req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    const fail = (status: number) => { if (!res.headersSent) res.writeHead(status, { "Cache-Control": "no-store" }); res.end(); };
    if (!req.url?.startsWith("/") || req.url.startsWith("//")) { fail(400); return; }
    let pathname: string;
    try { pathname = decodeURIComponent(new URL(req.url ?? "/", options.origin).pathname); }
    catch { fail(400); return; }
    if (pathname.includes("\\") || pathname.includes("\0") || pathname.split("/").some(p => p.startsWith("."))) { fail(404); return; }
    if (pathname === "/health") { res.writeHead(200, { "Cache-Control": "no-store" }).end("ok"); return; }
    if (pathname.startsWith("/api/")) {
      // Authorization is an internal edge-to-API operation, never a public route.
      if (pathname.startsWith("/api/live")) { fail(404); return; }
      const headers = proxyHeaders(req.headers);
      headers.host = new URL(options.origin).host;
      headers["x-forwarded-proto"] = "https";
      const proxy = request(new URL(req.url!, options.apiOrigin), { method: req.method, headers }, (response) => {
        res.writeHead(response.statusCode ?? 502, proxyHeaders(response.headers));
        pipeline(response, res, () => {});
      });
      proxy.setTimeout(120_000, () => proxy.destroy());
      proxy.on("error", () => { if (res.headersSent) res.destroy(); else fail(502); });
      req.on("aborted", () => proxy.destroy());
      res.on("close", () => { if (!res.writableFinished) proxy.destroy(); });
      pipeline(req, proxy, () => {});
      return;
    }
    if (pathname === "/internal" || pathname.startsWith("/internal/") || pathname === "/metrics") { fail(404); return; }
    if (req.method !== "GET" && req.method !== "HEAD") { fail(405); return; }
    void (async () => {
      let file = resolve(root, "." + pathname);
      if (!file.startsWith(root + sep)) file = resolve(root, "index.html");
      let info = await stat(file).catch(() => null);
      if (!info?.isFile()) {
        if (extname(pathname)) { fail(404); return; }
        file = resolve(root, "index.html"); info = await stat(file);
      }
      res.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream",
        "Content-Length": info.size,
        "Cache-Control": pathname.startsWith("/assets/") && file !== resolve(root, "index.html")
          ? "public, max-age=31536000, immutable" : "no-cache" });
      if (req.method === "HEAD") res.end(); else pipeline(createReadStream(file), res, () => {});
    })().catch(() => fail(503));
  });
  const stopLive = attachLiveProxy(server, options);
  server.on("upgrade", (req, socket) => { if (!req.url?.startsWith("/api/live")) socket.destroy(); });
  return { server, stopLive };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let options: ReturnType<typeof productionOptions>;
  try { options = productionOptions(process.env); }
  catch { process.stderr.write("Invalid dashboard server configuration\n"); process.exit(1); }
  const { server, stopLive } = createDashboardServer({ ...options, assets: process.env.DASHBOARD_ASSETS ?? "/app/dist" });
  server.listen(options.port, "0.0.0.0", () => process.stdout.write("Dashboard edge listening\n"));
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => {
    stopLive(); server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
