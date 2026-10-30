import type { IncomingMessage } from "node:http";
import type { EventEmitter } from "node:events";
import type { Duplex } from "node:stream";
import { z } from "zod";
import { WebSocket, WebSocketServer } from "ws";

export const LIVE_PATH = "/api/live/ws";
export function liveSource(raw: string): string | null {
  const url = new URL(raw, "http://localhost");
  const entries = [...url.searchParams];
  return url.pathname === LIVE_PATH && entries.length === 1 &&
    entries[0]?.[0] === "src" && /^camera_[12]_sub$/.test(entries[0][1])
    ? entries[0][1] : null;
}
// Normalize only the tiny, supported MSE control contract. All other protocol
// modes and upstream error details stay behind the edge.
const requestSchema = z.object({ type: z.literal("mse"),
  value: z.string().regex(/^avc1\.[0-9a-f]{6}(,avc1\.[0-9a-f]{6})*$/i),
}).strict();
const responseSchema = z.object({ type: z.literal("mse"),
  value: z.string().regex(/^video\/mp4; codecs="avc1\.[0-9a-f]{6}"$/i),
}).strict();
function mseMessage(raw: string, response: boolean): string | null {
  try {
    const result = (response ? responseSchema : requestSchema).safeParse(JSON.parse(raw));
    return result.success ? JSON.stringify(result.data) : null;
  } catch { return null; }
}
export const mseRequest = (raw: string) => mseMessage(raw, false);
export const mseResponse = (raw: string) => mseMessage(raw, true);
export interface LiveProxyOptions {
  origin: string;
  enabled: boolean;
  // Fixed, operator-owned internal upstream. Never derived from browser input.
  authorization: string;
  apiPort?: number;
  apiOrigin?: string;
  gatewayPort?: number;
  gatewayOrigin?: string;
  leaseMs?: number;
}
// Shared restricted edge: static production server and local Vite use identical gates.
export function attachLiveProxy(http: Pick<EventEmitter, "prependListener" | "once">, options: LiveProxyOptions) {
  const clients = new Set<Duplex>();
  const edge = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
  const reject = (socket: Duplex, status: number) => {
    socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
  };
  http.prependListener("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!req.url?.startsWith("/api/live")) return; // Leave Vite HMR alone.
    const src = liveSource(req.url);
    if (!options.enabled) return reject(socket, 503);
    if (!src || req.method !== "GET" || req.headers.upgrade?.toLowerCase() !== "websocket" ||
        req.headers["sec-websocket-version"] !== "13" ||
        !/^[A-Za-z0-9+/]{22}==$/.test(String(req.headers["sec-websocket-key"])) ||
        req.headers.origin !== options.origin || req.headers["sec-fetch-site"] === "cross-site")
      return reject(socket, 403);
    if (clients.size >= 4) return reject(socket, 429);
    clients.add(socket);
    const abort = new AbortController();
    const deadline = setTimeout(() => abort.abort(), 5000);
    socket.once("close", () => { clients.delete(socket); abort.abort(); });
    socket.on("error", () => socket.destroy());
    void (async () => {
      const auth = await fetch(`${options.apiOrigin ?? `http://127.0.0.1:${options.apiPort ?? 3001}`}/api/live/authorize?src=${src}`, {
        headers: { cookie: req.headers.cookie ?? "", origin: options.origin,
          "sec-fetch-site": "same-origin" },
        signal: abort.signal, redirect: "error",
      });
      await auth.body?.cancel();
      if (!auth.ok) return reject(socket, [401, 403, 503].includes(auth.status) ? auth.status : 403);
      if (socket.destroyed) return;
      const upstream = new WebSocket(`${options.gatewayOrigin ?? `ws://127.0.0.1:${options.gatewayPort ?? 1984}`}/api/ws?src=${src}`, {
        headers: { authorization: options.authorization },
        handshakeTimeout: 5000, maxPayload: 4 * 1024 * 1024,
        perMessageDeflate: false, followRedirects: false,
      });
      const cancel = () => upstream.terminate();
      abort.signal.addEventListener("abort", cancel, { once: true });
      let connected = false;
      upstream.once("error", () => { if (!connected && !socket.destroyed) reject(socket, 502); });
      upstream.once("open", () => {
        connected = true;
        if (socket.destroyed) { upstream.terminate(); return; }
        edge.handleUpgrade(req, socket, head, (browser) => {
          // Renew the authenticated handshake; continuous traffic must not
          // bypass expiry. No idle-timeout assumption for a video stream.
          const lease = setTimeout(() => socket.destroy(), options.leaseMs ?? 300_000);
          lease.unref();
          let requested = false, negotiated = false;
          const fail = () => {
            upstream.terminate();
            if (browser.readyState === WebSocket.OPEN) {
              browser.send(JSON.stringify({ type: "error", value: "Live stream unavailable" }));
              browser.close(1011, "Live stream unavailable");
            }
          };
          browser.on("message", (data, binary) => {
            const message = !binary && Buffer.isBuffer(data) && data.byteLength <= 1024 ? mseRequest(data.toString()) : null;
            if (!message || requested) { browser.close(1008, "MSE video only"); upstream.terminate(); return; }
            requested = true;
            upstream.send(message);
          });
          upstream.on("message", (data, binary) => {
            if (browser.readyState !== WebSocket.OPEN) return;
            if (browser.bufferedAmount > 2 * 1024 * 1024) { fail(); return; }
            if (binary) {
              if (!negotiated) { fail(); return; }
              browser.send(data, { binary: true });
            } else {
              const message = Buffer.isBuffer(data) && data.byteLength <= 1024 ? mseResponse(data.toString()) : null;
              // Never forward diagnostic text, source URLs or unknown commands.
              if (!message || negotiated) { fail(); return; }
              negotiated = true;
              browser.send(message);
            }
          });
          upstream.on("error", fail);
          upstream.once("close", () => { if (browser.readyState === WebSocket.OPEN) browser.close(1011, "Live stream ended"); });
          browser.on("error", () => upstream.terminate());
          browser.once("close", () => {
            clearTimeout(lease);
            abort.signal.removeEventListener("abort", cancel);
            upstream.terminate();
          });
        });
      });
    })().catch(() => { if (!socket.destroyed) reject(socket, 502); })
      .finally(() => clearTimeout(deadline));
  });

  http.once("close", () => { for (const client of clients) client.destroy(); edge.close(); });
  return () => { for (const client of clients) client.destroy(); };
}
