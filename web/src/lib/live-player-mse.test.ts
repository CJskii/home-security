import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LivePlayer } from "./live-player";

// Model Chromium's detached SourceBuffer: buffered throws, even for a queued
// updateend from the append that was in progress when video.src was cleared.
class BufferDouble extends EventTarget {
  updating = false;
  mode = "segments";
  detached = false;
  bufferedReads = 0;
  appendBuffer = vi.fn();
  remove = vi.fn();
  get buffered() {
    this.bufferedReads++;
    if (this.detached) throw new DOMException("SourceBuffer removed", "InvalidStateError");
    return { length: 1, start: () => 0, end: () => 3 };
  }
}
class SourceDouble extends EventTarget {
  static instances: SourceDouble[] = [];
  static isTypeSupported = () => true;
  readyState = "closed";
  sourceBuffers: BufferDouble[] = [];
  buffer = new BufferDouble();
  setLiveSeekableRange = vi.fn();
  constructor() { super(); SourceDouble.instances.push(this); }
  addSourceBuffer = vi.fn(() => { this.sourceBuffers.push(this.buffer); return this.buffer; });
  open() { this.readyState = "open"; this.dispatchEvent(new Event("sourceopen")); }
  detach() { this.readyState = "closed"; this.sourceBuffers = []; this.buffer.detached = true; }
}
let player: LivePlayer;
beforeEach(() => {
  SourceDouble.instances = [];
  vi.stubGlobal("MediaSource", SourceDouble);
  vi.stubGlobal("ManagedMediaSource", undefined);
  // Upstream checks property presence, not truthiness.
  Reflect.deleteProperty(window, "ManagedMediaSource");
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mse-test");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  player = new LivePlayer();
  player.oninit();
  player.onmessage = {};
});
afterEach(() => { player.stop(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function start() {
  player.onmse();
  const source = SourceDouble.instances.at(-1)!;
  source.open();
  player.onmessage.mse!({ type: "mse", value: 'video/mp4; codecs="avc1.640029"' });
  return source;
}
it("still appends live video and maintains playback while its buffer is attached", () => {
  const source = start();
  player.ondata!(new ArrayBuffer(4));
  expect(source.buffer.appendBuffer).toHaveBeenCalledOnce();
  source.buffer.dispatchEvent(new Event("updateend"));
  expect(source.buffer.bufferedReads).toBeGreaterThan(0);
});
it.each(["closed", "buffer_removed"])("ignores queued updates and packets after %s", (state) => {
  const source = start();
  const receive = player.ondata!;
  source.detach();
  if (state === "buffer_removed") source.readyState = "open";
  source.buffer.dispatchEvent(new Event("updateend"));
  receive(new ArrayBuffer(4));
  expect(source.buffer.bufferedReads).toBe(0);
  expect(source.buffer.appendBuffer).not.toHaveBeenCalled();
});
it("removes callbacks before navigation, hidden-tab or logout teardown", () => {
  const source = start();
  const remove = vi.spyOn(source.buffer, "removeEventListener");
  const receive = player.ondata!;
  player.stop();
  source.detach();
  source.buffer.dispatchEvent(new Event("updateend"));
  receive(new ArrayBuffer(4));
  expect(remove).toHaveBeenCalledWith("updateend", expect.any(Function));
  expect(source.buffer.bufferedReads).toBe(0);
  expect(player.ondata).toBeNull();
});
it("ignores late sourceopen and codec messages after disconnect", () => {
  player.onmse();
  const source = SourceDouble.instances[0]!;
  const codec = player.onmessage.mse!;
  player.ondisconnect();
  source.open();
  codec({ type: "mse", value: "stale codec" });
  expect(source.addSourceBuffer).not.toHaveBeenCalled();
});
it("isolates old buffer callbacks from a replacement stream on reconnect", () => {
  const old = start();
  const oldReceive = player.ondata!;
  const next = start();
  old.detach();
  old.dispatchEvent(new Event("sourceclose"));
  old.buffer.dispatchEvent(new Event("updateend"));
  oldReceive(new ArrayBuffer(4));
  player.ondata!(new ArrayBuffer(8));
  expect(old.buffer.bufferedReads).toBe(0);
  expect(old.buffer.appendBuffer).not.toHaveBeenCalled();
  expect(next.buffer.appendBuffer).toHaveBeenCalledOnce();
});
