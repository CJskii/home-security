import { useEffect, useRef, useState } from "react";
import { Maximize, Minimize, RefreshCw, VideoOff } from "lucide-react";
import { LivePlayer, supportsLive, type LiveState } from "@/lib/live-player";
import { sessionEvents } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { LiveZones, ZoneLegend } from "@/components/live-zones";
import { visibleZones, type CameraZone } from "@/lib/zones";

export function LiveView({ endpoint, name, loading = false, height, zones = [], showZones = false }: {
  endpoint: string | null; name: string; loading?: boolean; height?: number | null;
  zones?: CameraZone[]; showZones?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<LiveState>("connecting");
  const [attempt, setAttempt] = useState(0);
  const [visible, setVisible] = useState(!document.hidden);
  const [fullscreen, setFullscreen] = useState(false);
  const supported = supportsLive();
  useEffect(() => {
    const changed = () => setFullscreen(document.fullscreenElement === container.current);
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);
  useEffect(() => {
    const changed = () => setVisible(!document.hidden);
    const restored = (event: PageTransitionEvent) => {
      setVisible(!document.hidden);
      if (event.persisted) {
        setState("connecting");
        setAttempt((n) => n + 1);
      }
    };
    document.addEventListener("visibilitychange", changed);
    window.addEventListener("pageshow", restored);
    return () => {
      document.removeEventListener("visibilitychange", changed);
      window.removeEventListener("pageshow", restored);
    };
  }, []);
  useEffect(() => {
    // Accept only the API's fixed, same-origin source names, never arbitrary URLs.
    if (!supported || !visible || !endpoint || !/^\/api\/live\/ws\?src=camera_[12]_sub$/.test(endpoint)) return;
    const player = new LivePlayer();
    player.className = "block h-full w-full";
    player.report = setState;
    player.src = endpoint;
    host.current?.append(player);
    const stop = () => { player.stop(); setState("error"); };
    // A back/forward-cache freeze does not unmount React or necessarily change
    // visibility first. Stop synchronously, before that document is suspended.
    const suspend = () => player.stop();
    sessionEvents.addEventListener("ended", stop);
    window.addEventListener("pagehide", suspend);
    return () => {
      player.report = () => {};
      player.stop();
      player.remove();
      sessionEvents.removeEventListener("ended", stop);
      window.removeEventListener("pagehide", suspend);
    };
  }, [endpoint, attempt, supported, visible]);
  const unavailable = !endpoint || !supported || !visible;
  const label = loading ? "Loading stream profiles…" : !endpoint ? "Live gateway not configured" : !supported ?
    "H.264 MSE playback is unavailable in this browser" : !visible ? "Live view paused" :
    state === "error" ? "Live view unavailable. Check the gateway or sign in again." :
    state === "reconnecting" ? "Reconnecting…" : "Connecting to live view…";
  const connected = state === "playing" && !unavailable;
  const enabledZones = visibleZones(zones);
  return (
    <div ref={container} className="flex flex-col overflow-hidden rounded-lg border bg-black [&:fullscreen]:h-screen [&:fullscreen]:w-screen [&:fullscreen]:rounded-none">
      <div className="relative aspect-video min-h-0 w-full flex-1">
        <div ref={host} className="absolute inset-0" aria-label={`${name} live video`} />
        {showZones && connected && <LiveZones host={host} zones={enabledZones} name={name} />}
        {(unavailable || state !== "playing") && (
          <div role="status" className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70 p-4 text-center text-sm text-muted-foreground">
            {unavailable || state === "error" ? <VideoOff /> : <RefreshCw className="animate-spin" />}
            <p>{label}</p>
            {endpoint && supported && state === "error" && (
              <Button className="pointer-events-auto" size="sm" variant="secondary" onClick={() => { setState("connecting"); setAttempt((n) => n + 1); }}>Retry live view</Button>
            )}
          </div>
        )}
      </div>
      <div className="shrink-0 border-t bg-card px-3 py-2 text-xs text-muted-foreground" aria-label={`${name} live status`}>
        <div className="flex items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2" aria-live="polite">
            <Badge variant={connected ? "default" : "outline"}>{connected ? "LIVE" : loading ? "Loading" : !visible ? "Paused" : unavailable || state === "error" ? "Offline" : state === "reconnecting" ? "Reconnecting" : "Connecting"}</Badge>
            <span>H.264{height ? ` · ${height}p` : ""} · Substream</span>
          </div>
          <Button variant="ghost" size="icon" className="size-7 shrink-0" disabled={!connected && !fullscreen} aria-pressed={fullscreen} aria-label={fullscreen ? `Exit fullscreen ${name}` : `Expand ${name}`} onClick={() => {
            if (document.fullscreenElement === container.current) void document.exitFullscreen().catch(() => {});
            else void container.current?.requestFullscreen?.().catch(() => {});
          }}>{fullscreen ? <Minimize className="size-4" /> : <Maximize className="size-4" />}</Button>
        </div>
        {showZones && <ZoneLegend zones={enabledZones} name={name} />}
      </div>
    </div>
  );
}
