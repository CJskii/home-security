import { NotificationSettings } from './notification-settings';
import { AiProcessingSettings } from './ai-processing-settings';
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatTime } from "@/lib/api";
import { useCameraMetadata, useCameras, useConfigurationRefresh, useZonePreferenceSave } from "@/lib/camera-configuration";
import type { CameraConfiguration } from "@/lib/contracts";
import { zoneName, zoneStyle, zonePoints, hasValidZonePolygon, type CameraZone } from "@/lib/zones";

function SyncStatus({ camera }: { camera: CameraConfiguration }) {
  const sync = camera.synchronization;
  return <div className="space-y-1 text-xs text-muted-foreground" role="status">
    <p>{sync?.lastSuccessfulAt ? `Last successful sync ${formatTime(sync.lastSuccessfulAt)}` : "No verified NVR synchronization"}</p>
    {sync?.state === "stale" && <p className="text-amber-300">Stale · showing the last verified configuration.</p>}
    {sync?.error && <p className="text-amber-300">The last synchronization failed. Previously verified settings are retained.</p>}
    {sync?.lastAttemptAt && <p>Last attempted {formatTime(sync.lastAttemptAt)}</p>}
  </div>;
}
function ZoneRow({ zone, cameraId, editable }: { zone: CameraZone; cameraId: string; editable: boolean }) {
  const save = useZonePreferenceSave(cameraId, zone.id);
  const [draft, setDraft] = useState<{name:string;interested:boolean;fingerprint:string} | null>(null);
  const interest = zone.preference?.interested ?? false;
  const geometryChanged = draft !== null && draft.fingerprint !== zone.current?.geometryFingerprint;
  const validPreview = hasValidZonePolygon(zone);
  const style = zoneStyle(zone.slot);
  const current = zone.current;
  const enabled = current?.enabled && current.ruleEnabled === true;
  const state = !current ? "Unknown" : !current.enabled ? "Disabled" : current.ruleEnabled === null ? "Rule unknown" : current.ruleEnabled === false ? "Rule disabled" : "Enabled";
  const rule = current?.configuration;
  return <li className="space-y-2 border-t py-3 text-xs">
    <div className="flex items-center justify-between gap-3">
      <span className="font-medium">{zoneName(zone)} <span className="text-muted-foreground">· slot {zone.slot}</span></span>
      <Badge variant={enabled ? "secondary" : "outline"}>NVR {state}</Badge>
    </div>
    <div className="flex flex-wrap items-start gap-4">
      {validPreview ? <svg role="img" aria-label={`Zone ${zone.slot} current polygon`} viewBox="0 0 1280 720" className="aspect-video w-40 rounded border bg-muted/30">
        <title>{`Slot ${zone.slot} · current NVR polygon`}</title>
        <polygon points={zonePoints(zone,1280,720)} fill={style.color} fillOpacity={0.12} stroke={style.color} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeDasharray={style.dash}/>
      </svg> : <p className="text-muted-foreground">No valid polygon preview</p>}
      <div className="space-y-2">
        <p>Local interest: <strong>{interest ? 'Interested' : 'Not interested'}</strong>{interest && !enabled ? ' · inactive while NVR rule is disabled' : ''}</p>
        <p className="text-muted-foreground">NVR name: {zone.name?.trim() || `Zone ${zone.slot}`}</p>
        {!draft && <Button size="sm" variant="outline" disabled={!editable || !current?.geometryFingerprint} aria-label={`Edit local preferences for zone ${zone.slot}`} onClick={() => {
          save.reset(); setDraft({name:zone.preference?.displayName ?? '',interested:interest,fingerprint:current!.geometryFingerprint!});
        }}>Edit local preferences</Button>}
      </div>
    </div>
    {draft && <form aria-label={`Zone ${zone.slot} local preferences`} className="space-y-3 rounded-md border p-3" onSubmit={event => {
      event.preventDefault(); if(geometryChanged) return;
      void save.mutateAsync({displayName:draft.name.trim() || null,interested:draft.interested,expectedGeometryFingerprint:draft.fingerprint}).then(()=>setDraft(null)).catch(()=>{});
    }}>
      <div className="space-y-2"><Label htmlFor={`zone-name-${zone.id}`}>Local display name</Label>
        <Input id={`zone-name-${zone.id}`} value={draft.name} maxLength={128} disabled={save.isPending} placeholder={zone.name || `Zone ${zone.slot}`} onChange={e=>setDraft({...draft,name:e.target.value})}/>
      </div>
      <div className="flex items-center gap-2"><Input type="checkbox" id={`zone-interest-${zone.id}`} className="size-4 shrink-0" checked={draft.interested} disabled={save.isPending} onChange={e=>setDraft({...draft,interested:e.target.checked})}/>
        <Label htmlFor={`zone-interest-${zone.id}`}>Interested (local preference)</Label></div>
      <p className="text-muted-foreground">Candidate area for future notifications only. This does not change NVR enablement, event capture or AI processing, send notifications, or establish which rule triggered an event.</p>
      {geometryChanged && <p role="alert" className="text-amber-300">The NVR polygon changed while editing. Cancel and review the current preview.</p>}
      <div className="flex gap-2"><Button type="submit" size="sm" disabled={save.isPending || geometryChanged}>{save.isPending ? 'Saving…' : 'Save'}</Button>
        <Button type="button" size="sm" variant="outline" disabled={save.isPending} onClick={()=>{setDraft(null);save.reset();}}>Cancel</Button></div>
    </form>}
    {save.isError && <p role="alert" className="text-destructive">Local preferences were not saved. {save.error.message}</p>}
    {save.isSuccess && <p role="status" className="text-muted-foreground">Local zone preferences saved.</p>}
    <p className="text-muted-foreground">{current?.polygon.length ? `${current.polygon.length} vertices · normalized NVR coordinates` : "No configured polygon"}{current?.revision ? ` · version ${current.revision}` : ""}</p>
    {rule && <div className="space-y-1 text-muted-foreground">
      <p>Sensitivity {rule.sensitivity ?? "unknown"} · priority {rule.priority ?? "unknown"}</p>
      {rule.targets.map((target, index) => <p key={index}>NVR target type {target.Type} · {target.Enabled ? "enabled" : "disabled"}
        {target.ObjectMinSize && ` · minimum ${target.ObjectMinSize.Width}×${target.ObjectMinSize.Height}`}
        {target.ObjectMaxSize && ` · maximum ${target.ObjectMaxSize.Width}×${target.ObjectMaxSize.Height}`}</p>)}
    </div>}
    {current && <p className="text-muted-foreground">Last observed {formatTime(current.lastObservedAt ?? current.observedAt)}</p>}
  </li>;
}
function CameraSettings({ camera, available }: { camera: CameraConfiguration; available: boolean }) {
  const { streams, zones } = useCameraMetadata(camera.id);
  const refresh = useConfigurationRefresh();
  const enabled = zones.data?.zones.filter(z => z.current?.enabled && z.current.ruleEnabled === true) ?? [];
  const other = zones.data?.zones.filter(z => !enabled.includes(z)) ?? [];
  return <Card>
    <CardHeader>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><CardTitle><h2>{camera.name}</h2></CardTitle><CardDescription className="mt-2">{camera.id} · NVR channel {camera.channel}</CardDescription></div>
        <Button variant="outline" size="sm" aria-label={`Refresh ${camera.name} from NVR`} disabled={!available || refresh.pending} onClick={() => refresh.mutate(camera.id)}>
          <RefreshCw className={refresh.isPending ? "size-4 animate-spin" : "size-4"} />{refresh.isPending ? "Refreshing…" : "Refresh from NVR"}
        </Button>
      </div>
    </CardHeader>
    <CardContent className="space-y-5">
      <SyncStatus camera={camera} />
      {refresh.isError && <p role="alert" className="text-xs text-destructive">Refresh failed. Last verified settings retained. {refresh.error.message}</p>}
      {refresh.isSuccess && <p role="status" className="text-xs text-muted-foreground">Camera configuration refreshed from the NVR.</p>}
      <section aria-label={`${camera.name} stream profiles`}>
        <h3 className="mb-2 text-sm font-medium">Stream profiles</h3>
        {streams.isPending ? <Skeleton className="h-16" /> : streams.isError ? <p role="alert" className="text-xs">Stream metadata unavailable. {streams.error.message}</p> : <>
          {streams.data.profiles.length === 0 && <p className="text-xs text-muted-foreground">No verified stream profiles available.</p>}
          {streams.data.profiles.map(p => <div key={p.id} className="flex flex-wrap justify-between gap-2 border-t py-2 text-xs">
            <span>{p.id} · {p.enabled === null ? "state unknown" : p.enabled ? "enabled" : "disabled"}</span>
            <span className="text-muted-foreground">{p.videoCodec?.toUpperCase() ?? "Unknown codec"} · {p.width ?? "?"}×{p.height ?? "?"} · {p.fps ?? "?"} fps configured</span>
          </div>)}
          {streams.data.discovery.stale && <p className="text-xs text-amber-300">Stream metadata is stale.</p>}
        </>}
      </section>
      <section aria-label={`${camera.name} detection rules`}>
        <h3 className="text-sm font-medium">EnterArea rules · {enabled.length} enabled</h3>
        {zones.isPending ? <Skeleton className="mt-2 h-20" /> : zones.isError ? <p role="alert" className="mt-2 text-xs">Zone metadata unavailable. {zones.error.message}</p> : <>
          {!zones.data.zones.length && <p className="mt-2 text-xs text-muted-foreground">No stored detection rules.</p>}
          {!!zones.data.zones.length && !enabled.length && <p className="mt-2 text-xs text-muted-foreground">No enabled detection rules.</p>}
          {!zones.data.preferencesAvailable && <p className="mt-2 text-xs text-amber-300">Local zone preferences require the upgraded API and zone-preferences migration. Source metadata remains available.</p>}
          <ul>{enabled.map(zone => <ZoneRow key={zone.id} zone={zone} cameraId={camera.id} editable={zones.data?.preferencesAvailable === true && !refresh.pending} />)}</ul>
          {!!other.length && <details className="rounded-md border p-3 text-xs"><summary className="cursor-pointer">Disabled or unverified rules ({other.length})</summary><ul className="mt-2">{other.map(zone => <ZoneRow key={zone.id} zone={zone} cameraId={camera.id} editable={zones.data?.preferencesAvailable === true && !refresh.pending} />)}</ul></details>}
        </>}
      </section>
    </CardContent>
  </Card>;
}
export function CameraSettingsPage() {
  const cameras = useCameras(), refresh = useConfigurationRefresh();
  return <>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h1 className="text-2xl font-semibold">Settings</h1><h2 className="mt-3 text-base font-medium">Cameras &amp; Zones</h2>
        <p className="mt-2 max-w-2xl text-xs text-muted-foreground">Uniview owns camera settings and detection polygons. Edit them in the NVR software. Home Security reads configuration at startup and every 10 minutes when the upgraded receiver is configured.</p></div>
      <Button variant="outline" size="sm" disabled={!cameras.data?.refreshAvailable || refresh.pending} onClick={() => refresh.mutate(undefined)}><RefreshCw className={refresh.isPending ? "size-4 animate-spin" : "size-4"} />{refresh.isPending ? "Refreshing…" : "Refresh both cameras from NVR"}</Button>
    </div>
    {cameras.isError && <div role="alert" className="space-y-2 text-sm"><p>{cameras.error.message}</p><Button variant="outline" size="sm" onClick={() => { void cameras.refetch(); }}>Retry camera metadata</Button></div>}
    {!cameras.isPending && !cameras.isError && !cameras.data?.refreshAvailable && <p role="status" className="text-xs text-amber-300">Refresh is unavailable until the upgraded receiver, database migration and configuration connection are enabled. Stored metadata remains available.</p>}
    {refresh.isError && <p role="alert" className="text-xs text-destructive">Refresh failed. Last verified settings retained. {refresh.error.message}</p>}
    {refresh.isSuccess && <p role="status" className="text-xs text-muted-foreground">Camera configuration refreshed from the NVR.</p>}
    <div className="grid gap-5 xl:grid-cols-2">
      {cameras.isPending ? <><Skeleton className="h-80" /><Skeleton className="h-80" /></> : cameras.data?.cameras.map(camera => <CameraSettings key={camera.id} camera={camera} available={cameras.data.refreshAvailable} />)}
      {cameras.data?.cameras.length === 0 && <p className="text-sm text-muted-foreground">No cameras configured.</p>}
    </div>
    <p className="text-xs text-muted-foreground">Rule regions are not verified event-trigger attribution. Disabled rules are excluded from live overlays. Configured FPS and stream enablement do not establish reachability.</p>
    <AiProcessingSettings/>
    <NotificationSettings/>
    <Card><CardHeader><CardTitle><h2>Future settings</h2></CardTitle></CardHeader><CardContent className="grid gap-4 text-sm sm:grid-cols-3">{["System"].map(name => <div key={name}><h2 className="font-medium">{name}</h2><p className="mt-1 text-xs text-muted-foreground">Planned for a future milestone.</p></div>)}</CardContent></Card>
  </>;
}
