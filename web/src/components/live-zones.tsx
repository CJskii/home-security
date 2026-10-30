import { useEffect, useState, type RefObject } from "react";
import { zoneName, zonePoints, zoneStyle, type CameraZone } from "@/lib/zones";
export function LiveZones({ host, zones, name }: {
  host: RefObject<HTMLDivElement | null>; zones: CameraZone[]; name: string;
}) {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    const video = host.current?.querySelector("video");
    if (!video) return;
    const measure = () => setSize(video.videoWidth > 0 && video.videoHeight > 0
      ? { width: video.videoWidth, height: video.videoHeight } : null);
    measure();
    video.addEventListener("loadedmetadata", measure);
    video.addEventListener("resize", measure);
    return () => {
      video.removeEventListener("loadedmetadata", measure);
      video.removeEventListener("resize", measure);
    };
  }, [host]);
  if (!size || !zones.length) return null;
  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${size.width} ${size.height}`} preserveAspectRatio="xMidYMid meet" aria-label={`${name} stored NVR detection zones`} role="img">
      {zones.map(zone => {
        const style = zoneStyle(zone.slot);
        return <polygon key={zone.id} points={zonePoints(zone, size.width, size.height)} fill={style.color} fillOpacity={0.035} stroke={style.color} strokeWidth={1.5} strokeDasharray={style.dash} vectorEffect="non-scaling-stroke"><title>{zoneName(zone)}</title></polygon>;
      })}
    </svg>
  );
}
export function ZoneLegend({ zones, name }: { zones: CameraZone[]; name: string }) {
  return <div className="mt-2 space-y-2 border-t pt-2">
    <ul className="flex flex-wrap gap-x-4 gap-y-2" aria-label={`${name} visible detection zones`}>
      {zones.map(zone => <li key={zone.id} className="flex items-center gap-2">
        <svg aria-hidden="true" width="24" height="8"><path d="M0 4H24" stroke={zoneStyle(zone.slot).color} strokeWidth="2" strokeDasharray={zoneStyle(zone.slot).dash} /></svg>
        <span>{zoneName(zone)}</span>
      </li>)}
    </ul>
    {!zones.length && <p>No enabled zones with valid stored geometry.</p>}
    <p className="text-[10px]">Stored NVR rule regions · not event-trigger attribution.</p>
  </div>;
}
