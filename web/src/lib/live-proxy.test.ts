// @vitest-environment node
import { createServer as createHttpServer, request } from "node:http";
import { createHash } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { createServer } from "vite";
import { afterEach, expect, it } from "vitest";
import { liveProxy, liveSource, mseRequest, mseResponse } from "../../dev/live-proxy";

const origin = "https://security.test";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
it("accepts only the two exact named substreams, with one src parameter", () => {
  expect(liveSource("/api/live/ws?src=camera_1_sub")).toBe("camera_1_sub");
  expect(liveSource("/api/live/ws?src=camera_2_sub")).toBe("camera_2_sub");
  for (const url of ["/api/live/ws?src=camera_1_main", "/api/live/ws?src=rtsp://secret", "/api/live/ws?src=camera_1_sub&src=camera_2_sub", "/api/live/ws?src=camera_1_sub&url=evil", "/api/live/config?src=camera_1_sub"])
    expect(liveSource(url)).toBeNull();
});
it("authenticates before opening media, strips browser secrets, denies control paths and bounds the connection lease", async () => {
  let authCalls = 0, mediaCalls = 0;
  const auth = createHttpServer((req, res) => {
    authCalls++;
    expect(req.url).toBe("/api/live/authorize?src=camera_1_sub");
    expect(req.headers.origin).toBe(origin);
    res.writeHead(req.headers.cookie === "dashboard_session=valid" ? 200 : 401).end();
  });
  const media = createHttpServer();
  const upstreamSockets = new Set<Duplex>();
  media.on("upgrade", (req, socket) => {
    mediaCalls++;
    upstreamSockets.add(socket);
    socket.on("close", () => upstreamSockets.delete(socket));
    expect(req.url).toBe("/api/ws?src=camera_1_sub");
    expect(req.headers.authorization).toBe("Basic server-secret");
    expect(req.headers.cookie).toBeUndefined();
    const accept = createHash("sha1").update(String(req.headers["sec-websocket-key"]) + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  });
  for (const server of [auth, media]) {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => { for (const socket of upstreamSockets) socket.destroy(); return new Promise<void>((resolve) => server.close(() => resolve())); });
  }
  const edge = await createServer({ configFile: false, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
    plugins: [liveProxy({ origin, enabled: true, authorization: "Basic server-secret", apiPort: (auth.address() as AddressInfo).port,
      gatewayPort: (media.address() as AddressInfo).port, leaseMs: 100 })] });
  await edge.listen();
  cleanup.push(() => edge.close());
  const port = (edge.httpServer!.address() as AddressInfo).port;
  async function handshake(path: string, cookie = "dashboard_session=valid", requestOrigin = origin) {
    return new Promise<{ status: number; socket?: Duplex }>((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port, path, headers: { connection: "Upgrade", upgrade: "websocket",
        "sec-websocket-version": "13", "sec-websocket-key": Buffer.from("the sample nonce").toString("base64"), cookie, origin: requestOrigin,
        authorization: "Bearer browser-secret" } });
      req.on("upgrade", (response, socket) => resolve({ status: response.statusCode!, socket }));
      req.on("response", (response) => { response.resume(); resolve({ status: response.statusCode! }); });
      req.on("error", reject);
      req.end();
    });
  }
  const path = "/api/live/ws?src=camera_1_sub";
  expect((await handshake(path, "bad")).status).toBe(401);
  expect((await handshake(path, "dashboard_session=valid", "https://evil.test")).status).toBe(403);
  expect((await handshake(path + "&url=evil")).status).toBe(403);
  expect(mediaCalls).toBe(0);
  const live = await handshake(path);
  expect(live.status).toBe(101);
  expect(mediaCalls).toBe(1);
  expect(authCalls).toBe(2);
  live.socket!.resume();
  await new Promise<void>((resolve) => live.socket!.once("close", resolve));
  expect((await fetch(`http://127.0.0.1:${port}/api/live/config`)).status).toBe(404);
});

it("allows only H.264 MSE messages and withholds raw gateway errors and other modes", () => {
  const message = { type: "mse", value: "avc1.640029,avc1.64002A" };
  expect(mseRequest(JSON.stringify(message))).toBe(JSON.stringify(message));
  expect(mseResponse(JSON.stringify({ type: "mse", value: 'video/mp4; codecs="avc1.4D4029"' }))).toBeTruthy();
  for (const value of [{ type: "error", value: "rtsp://private:secret@internal/path" },
    { type: "webrtc/offer", value: "sdp" }, { type: "mse", value: "rtsp://private" },
    { type: "mse", value: "avc1.640029", extra: "unsafe" }]) {
    expect(mseRequest(JSON.stringify(value))).toBeNull();
    expect(mseResponse(JSON.stringify(value))).toBeNull();
  }
  expect(mseRequest("malformed")).toBeNull();
});

it("relays negotiated video and replaces upstream private diagnostics on the wire", async () => {
  const auth = createHttpServer((_req, res) => res.writeHead(200).end());
  const gateway = createHttpServer();
  const media = new WebSocketServer({ server: gateway });
  let forwarded = 0;
  media.on("connection", (socket) => {
    socket.on("message", () => {
      forwarded++;
      socket.send(JSON.stringify({ type: "mse", value: 'video/mp4; codecs="avc1.4D4029"' }));
      socket.send(Buffer.from([1, 2, 3]));
      socket.send(JSON.stringify({ type: "error", value: "rtsp://private:secret@internal/path" }));
    });
  });
  for (const server of [auth, gateway]) {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => { for (const client of media.clients) client.terminate(); return new Promise<void>((resolve) => server.close(() => resolve())); });
  }
  const edge = await createServer({ configFile: false, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null }, plugins: [
    liveProxy({ origin, enabled: true, authorization: "Basic secret", apiPort: (auth.address() as AddressInfo).port,
      gatewayPort: (gateway.address() as AddressInfo).port }),
  ] });
  await edge.listen(); cleanup.push(() => edge.close());
  const url = `ws://127.0.0.1:${(edge.httpServer!.address() as AddressInfo).port}/api/live/ws?src=camera_1_sub`;
  const browser = new WebSocket(url, { origin, headers: { cookie: "dashboard_session=valid" } });
  const received: string[] = [];
  browser.on("open", () => browser.send(JSON.stringify({ type: "mse", value: "avc1.640029" })));
  browser.on("message", (data, binary) => received.push(binary ? `video:${Buffer.isBuffer(data) ? data.toString("hex") : "invalid"}` : data.toString()));
  await new Promise<void>((resolve, reject) => { browser.once("close", () => resolve()); browser.once("error", reject); });
  expect(received).toEqual([
    JSON.stringify({ type: "mse", value: 'video/mp4; codecs="avc1.4D4029"' }),
    "video:010203", JSON.stringify({ type: "error", value: "Live stream unavailable" }),
  ]);
  expect(received.join()).not.toMatch(/rtsp|private|secret|internal/);
  const invalid = new WebSocket(url, { origin, headers: { cookie: "dashboard_session=valid" } });
  invalid.on("open", () => invalid.send(JSON.stringify({ type: "webrtc/offer", value: "sdp" })));
  const code = await new Promise<number>((resolve, reject) => { invalid.once("close", resolve); invalid.once("error", reject); });
  expect(code).toBe(1008);
  expect(forwarded).toBe(1);
});
