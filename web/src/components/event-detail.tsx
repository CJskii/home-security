import { ObjectDetail } from "./event-object-detail";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Minus, Plus, RotateCcw, Scan } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EventMedia } from "./event-media";
import { api, display, formatTime } from "@/lib/api";
import { eventSchema, type SecurityEvent } from "@/lib/contracts";
export function EventDetail({
  id,
  initial,
  close,
}: {
  id: string;
  initial?: SecurityEvent;
  close: () => void;
}) {
  const query = useQuery({
    queryKey: ["event", id],
    queryFn: ({ signal }) => api(`/api/events/${id}`, eventSchema, signal),
    initialData: initial,
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="max-h-[94dvh] overflow-y-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>Detection details</DialogTitle>
          <DialogDescription>
            Original Uniview evidence and separately labelled AI interpretation.
          </DialogDescription>
        </DialogHeader>
        {query.data ? (
          <DetailBody event={query.data} />
        ) : (
          <p role="status">
            {query.isError ? query.error.message : "Loading detection…"}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
function DetailBody({ event }: { event: SecurityEvent }) {
  const [selected, setSelected] = useState(
    event.objects.find((o) => o.images.fullFrameId)?.images.fullFrameId ??
      event.images.find((i) => i.type === 1)?.id,
  );
  const [zoom, setZoom] = useState(1),
    [boxes, setBoxes] = useState(false);
  const frame = event.images.find((i) => i.id === selected && i.type === 1);
  const linked = event.objects.filter((object) => object.analysis || object.images.cropId || object.images.fullFrameId);
  const primary = linked.length ? linked : event.objects;
  const additional = event.objects.filter((object) => !primary.includes(object));
  // Source reports stay separate and retain their UUIDs. Same-event grouping is
  // presentation only, never a physical-subject identity mapping.
  const seenNotes = new Set<string>();
  const uniqueNotes = (values: string[]) => values.filter((value) => {
    if (seenNotes.has(value)) return false;
    seenNotes.add(value);
    return true;
  });
  const notes = new Map(event.objects.map((object) => [object.id, uniqueNotes([
    ...(object.analysis?.uncertainties ?? []),
    ...Object.values(object.analysis?.attributeEvidence ?? {}).flatMap((evidence) => evidence.uncertainty ? [evidence.uncertainty] : []),
  ])]));
  const eventNotes = uniqueNotes(event.analysis?.uncertainties ?? []);
  const showEventDescription = !event.objects.some((object) => object.analysis?.shortDescription);
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge variant="outline">{event.camera}</Badge>
        <span>{formatTime(event.timestamp.value)} · Europe/London</span>
        <Badge variant="secondary">
          AI {display(event.processing?.status ?? "missing")}
        </Badge>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          aria-label="Zoom out"
          onClick={() => setZoom((n) => Math.max(1, n - 0.5))}
        >
          <Minus />
        </Button>
        <span className="text-xs">{zoom}×</span>
        <Button
          variant="outline"
          size="sm"
          aria-label="Zoom in"
          onClick={() => setZoom((n) => Math.min(4, n + 0.5))}
        >
          <Plus />
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setZoom(1)}>
          <RotateCcw />
          Reset
        </Button>
        <Button
          variant={boxes ? "secondary" : "ghost"}
          size="sm"
          onClick={() => setBoxes(!boxes)}
        >
          <Scan />
          Source boxes
        </Button>
        <span className="text-xs text-muted-foreground">
          Scroll to pan when zoomed
        </span>
      </div>
      <div className="max-h-[65vh] overflow-auto rounded-lg border bg-black/30">
        <div style={{ width: `${zoom * 100}%` }}>
          <div
            className="relative"
            style={{
              aspectRatio:
                frame?.width && frame.height
                  ? `${frame.width}/${frame.height}`
                  : "16/9",
            }}
          >
            <EventMedia image={frame}>
              {boxes && frame && (
                <svg
                  className="pointer-events-none absolute inset-0 size-full"
                  viewBox="0 0 10000 10000"
                  preserveAspectRatio="none"
                  aria-label="NVR source object bounding boxes"
                >
                  {event.objects
                    .filter((o) => o.rectangle?.imageId === frame.id)
                    .map((o) => {
                      const r = o.rectangle!;
                      return (
                        <rect
                          key={o.id}
                          x={r.xMin}
                          y={r.yMin}
                          width={r.xMax - r.xMin}
                          height={r.yMax - r.yMin}
                          fill="none"
                          stroke="#74d7ba"
                          strokeWidth="2"
                          vectorEffect="non-scaling-stroke"
                        />
                      );
                    })}
                </svg>
              )}
            </EventMedia>
          </div>
        </div>
      </div>
      {event.images.filter((i) => i.type === 1).length > 1 && (
        <div className="flex flex-wrap gap-2">
          {event.images
            .filter((i) => i.type === 1)
            .map((i, index) => (
              <Button
                key={i.id}
                size="sm"
                variant={selected === i.id ? "secondary" : "outline"}
                onClick={() => {
                  setSelected(i.id);
                  setZoom(1);
                }}
              >
                Frame {index + 1}
              </Button>
            ))}
        </div>
      )}
      {showEventDescription && (
        <div className="rounded-lg border bg-muted/30 p-3">
          <p className="mb-1 text-xs text-muted-foreground">AI interpretation</p>
          <p className="text-sm">{event.analysis?.shortDescription ?? `No AI description · ${display(event.processing?.reason ?? "not processed")}`}</p>
        </div>
      )}
      {eventNotes.length > 0 && <details className="text-xs"><summary className="cursor-pointer text-muted-foreground">Event uncertainty and validation</summary><ul className="mt-2 space-y-1">{eventNotes.map((note) => <li key={note}>{note}</li>)}</ul></details>}
      <div>
        <h3 className="text-sm font-medium">Source object observations</h3>
        <p className="mt-1 text-xs text-muted-foreground">Original NVR facts and AI interpretations remain separate. Reports are not unique subject counts.</p>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {primary.map((object) => <ObjectDetail key={object.id} object={object} images={event.images} notes={notes.get(object.id) ?? []} />)}
      </div>
      {additional.length > 0 && (
        <details className="rounded-lg border p-3">
          <summary className="cursor-pointer text-sm">Additional NVR source reports ({additional.length})</summary>
          <p className="my-3 text-xs text-muted-foreground">These reports belong to this canonical event. A shared physical subject has not been verified; all source identities are preserved.</p>
          <div className="grid gap-3 md:grid-cols-2">{additional.map((object) => <ObjectDetail key={object.id} object={object} images={event.images} notes={notes.get(object.id) ?? []} />)}</div>
        </details>
      )}
      <p className="text-xs text-muted-foreground">
        Time basis: {display(event.timestamp.source)}. Image capture time may
        differ. AI confidence is an uncalibrated model assessment.
      </p>
      {(event.truncated.images || event.truncated.objects) && (
        <p className="text-xs text-amber-300">
          This response is bounded. Additional observations or image metadata
          exist.
        </p>
      )}
    </div>
  );
}
