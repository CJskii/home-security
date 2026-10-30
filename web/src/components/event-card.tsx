import { locationNames, aiStatus } from './event-location';
import { ChevronRight } from "lucide-react";
import { eventCategories } from "@/lib/classification";
import { CategoryLabel } from "./category-label";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EventMedia } from "./event-media";
import { formatTime, thumbnail } from "@/lib/api";
import type { SecurityEvent } from "@/lib/contracts";
export function EventCard({
  event,
  onOpen,
  mediaEnabled = true,
}: {
  event: SecurityEvent;
  onOpen: () => void;
  mediaEnabled?: boolean;
}) {
  const capacitySkipped = event.processing?.status === "SKIPPED" &&
    ["capacity_exceeded", "eligibility_buffer_limit", "memory_limit"].includes(event.processing.reason ?? "");
  const description = event.analysis?.shortDescription.trim() ||
    (capacitySkipped ? "AI description skipped due to limited processing capacity." : null);
  return (
    <Card className="gap-0 overflow-hidden py-0 transition-colors hover:border-primary/45">
      <div
        className="relative aspect-video cursor-pointer"
        role="button"
        tabIndex={0}
        aria-label="Open original detection"
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen();
          }
        }}
      >
        <EventMedia image={mediaEnabled ? thumbnail(event) : undefined} emptyLabel="No object crop · open event" />
        <span className="absolute bottom-2 left-2 rounded bg-black/75 px-2 py-1 text-[10px]">
          {event.camera}
        </span>
      </div>
      <CardContent className="p-3">
        <button
          onClick={onOpen}
          className="w-full cursor-pointer text-left"
          aria-label={`View event ${formatTime(event.timestamp.value)}`}
        >
          <div className="mb-2 flex items-center justify-between gap-1">
            <span className="flex flex-wrap gap-2 text-xs font-medium">
              {eventCategories(event).map((category) => (
                <CategoryLabel key={category} category={category} />
              ))}
            </span>
            <ChevronRight className="size-3 text-muted-foreground" />
          </div>
          <p className="mb-3 line-clamp-2 min-h-8 text-xs leading-relaxed text-muted-foreground">
            {description}
          </p>
          {locationNames(event).length>0&&<p className="mb-2 line-clamp-1 text-[10px] text-muted-foreground" title="Geometric location estimate; current local aliases on historical source polygons">Location · {locationNames(event).map(z=>`${z.name} (v${z.revision??'?'})`).join(', ')}</p>}
          <div className="flex items-center justify-between gap-1 text-[10px] text-muted-foreground">
            <time dateTime={event.timestamp.value}>
              {formatTime(event.timestamp.value)}
            </time>
            <Badge variant="secondary" className="text-[9px]">
              {aiStatus(event)}
            </Badge>
          </div>
        </button>
      </CardContent>
    </Card>
  );
}
