import { z } from "zod";
import { api } from "./api";
import { VideoRTC } from "@/vendor/go2rtc/video-rtc.js";
export type LiveState = "connecting" | "playing" | "reconnecting" | "error";

// Keep the reviewed upstream MSE protocol, with an explicit dashboard lifecycle.
export class LivePlayer extends VideoRTC {
  report: (state: LiveState) => void = () => {};
  private active = true;
  private checking = false;
  private attempts = 0;
  private sessionCheck?: AbortController;
  private watchdog?: ReturnType<typeof setTimeout>;
  constructor() {
    super();
    this.mode = "mse";
    this.media = "video";
    this.visibilityCheck = false; // React owns visibility listeners and disposal.
    this.CODECS = this.CODECS.filter((codec) => codec.startsWith("avc1"));
  }
  oninit() {
    this.video = document.createElement("video");
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.autoplay = true;
    this.video.controls = false;
    this.video.className = "h-full w-full object-contain";
    this.video.addEventListener("playing", () => {
      clearTimeout(this.watchdog);
      this.attempts = 0;
      this.report("playing");
    });
    this.video.addEventListener("error", () => { if (this.active && this.ws) this.fail(); });
    this.append(this.video);
  }
  onconnect(): boolean {
    if (!this.active || !this.isConnected || !this.wsURL || this.ws || this.checking || document.hidden) return false;
    this.checking = true;
    this.sessionCheck = new AbortController();
    this.report(this.attempts ? "reconnecting" : "connecting");
    void api("/api/session", z.object({ authenticated: z.literal(true) }), this.sessionCheck.signal)
      .then(() => {
        if (!this.active || !this.isConnected || document.hidden) return;
        super.onconnect();
        this.watchdog = setTimeout(() => this.fail(), 20_000);
      }).catch(() => { if (this.active) this.fail(); })
      .finally(() => { this.checking = false; });
    return true;
  }
  onopen() {
    const modes = super.onopen();
    this.onmessage.dashboard = (message) => {
      // Never render raw upstream errors (they can contain private RTSP URLs).
      if (message.type === "error") this.fail();
    };
    return modes;
  }
  onclose(): boolean {
    if (!this.active || this.wsState === WebSocket.CLOSED) return false;
    this.ondisconnect();
    clearTimeout(this.watchdog);
    if (++this.attempts > 3) { this.fail(); return false; }
    this.report("reconnecting");
    this.reconnectTID = window.setTimeout(() => {
      this.reconnectTID = 0;
      this.onconnect();
    }, Math.min(this.attempts * 2000, 6000));
    return true;
  }
  ondisconnect() {
    if (this.video?.src.startsWith("blob:")) URL.revokeObjectURL(this.video.src);
    if (this.video) super.ondisconnect();
    this.ondata = null;
    this.onmessage = {};
  }
  disconnectedCallback() { this.stop(); }
  private fail() { this.stop(); this.report("error"); }
  stop() {
    this.active = false;
    this.sessionCheck?.abort();
    clearTimeout(this.watchdog);
    clearTimeout(this.reconnectTID);
    clearTimeout(this.disconnectTID);
    this.ondisconnect();
  }
}
if (!customElements.get("security-live")) customElements.define("security-live", LivePlayer);
export function supportsLive() {
  return typeof MediaSource !== "undefined" && MediaSource.isTypeSupported('video/mp4; codecs="avc1.640029"');
}
