import { Link } from "react-router";
import { LiveView } from "./live-view";
import { useCameraMetadata } from "@/lib/camera-configuration";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import type { CameraConfiguration } from "@/lib/contracts";
export function CameraPanel({ camera, showZones = false }: { camera: CameraConfiguration; showZones?: boolean }) {
  const { streams, zones } = useCameraMetadata(camera.id);
  const low = streams.data?.profiles.find(profile => profile.id === "sub");
  const endpoint = low?.enabled === true && low.videoCodec === "h264" ? low.playback?.endpoint ?? null : null;
  return <Card>
    <CardHeader><CardTitle>{camera.name}</CardTitle><CardDescription>{camera.id} · NVR channel {camera.channel}</CardDescription></CardHeader>
    <CardContent className="space-y-4">
      <LiveView name={camera.name} endpoint={endpoint} height={low?.height} loading={streams.isPending} showZones={showZones} zones={zones.data?.zones ?? []} />
      {streams.isError && <p role="alert" className="text-xs text-muted-foreground">Stream metadata unavailable. {streams.error.message}</p>}
      {showZones && zones.isError && <p role="alert" className="text-xs text-muted-foreground">Zone metadata unavailable. Live playback is unaffected.</p>}
      {showZones && zones.isPending && <p role="status" className="text-xs text-muted-foreground">Loading stored zones…</p>}
      <Link className="text-xs text-muted-foreground underline underline-offset-4" to="/settings">Camera &amp; zone settings</Link>
    </CardContent>
  </Card>;
}
