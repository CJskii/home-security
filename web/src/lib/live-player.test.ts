import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LivePlayer } from "./live-player";
class FakeSocket extends EventTarget {
  static CLOSED = 3;
  static CONNECTING = 0;
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  binaryType = "";
  constructor(readonly url: string) { super(); FakeSocket.instances.push(this); }
  close() { this.dispatchEvent(new Event("close")); }
}
let player: LivePlayer;
beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ authenticated: true }))));
  player = new LivePlayer();
  player.src = "/api/live/ws?src=camera_1_sub";
  document.body.append(player);
});
afterEach(() => { player.stop(); player.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it("checks the session before media, requests only MSE/video/H.264 and closes immediately on unmount", async () => {
  await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
  expect(player.mode).toBe("mse");
  expect(player.media).toBe("video");
  expect(player.video.controls).toBe(false);
  expect(player.video.muted).toBe(true);
  expect(player.video.autoplay).toBe(true);
  expect(player.video.playsInline).toBe(true);
  expect(player.CODECS.every((codec) => codec.startsWith("avc1"))).toBe(true);
  expect(fetch).toHaveBeenCalledWith("/api/session", expect.objectContaining({ credentials: "same-origin" }));
  player.remove();
  expect(player.ws).toBeNull();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(FakeSocket.instances).toHaveLength(1);
});
it("bounds automatic reconnection to three attempts and exposes a retryable error", async () => {
  const report = vi.fn(); player.report = report;
  await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
  for (let n = 0; n < 4; n++) {
    FakeSocket.instances[n]!.close();
    await vi.advanceTimersByTimeAsync(6000);
  }
  expect(FakeSocket.instances).toHaveLength(4);
  expect(report).toHaveBeenLastCalledWith("error");
  expect(player.ws).toBeNull();
});
it("does not reopen a player after it was disposed during a session check", async () => {
  player.stop(); player.remove(); FakeSocket.instances = [];
  let resolve!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((done) => { resolve = done; })));
  player = new LivePlayer();
  player.src = "/api/live/ws?src=camera_1_sub";
  document.body.append(player);
  player.remove();
  resolve(new Response(JSON.stringify({ authenticated: true })));
  await vi.advanceTimersByTimeAsync(30_000);
  expect(FakeSocket.instances).toHaveLength(0);
});
