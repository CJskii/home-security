import { ObjectLocationDetails } from './event-location';
import type { SecurityEvent } from "@/lib/contracts";
import { display } from "@/lib/api";
import { objectCategory } from "@/lib/classification";
import { Badge } from "./ui/badge";
import { EventMedia } from "./event-media";
import { CategoryLabel } from "./category-label";

type SourceObject = SecurityEvent["objects"][number];
const fieldName = (field: string) => display(field.replace(/([A-Z])/g, " $1"));
function populated(value: unknown): string | null {
  if (typeof value === "string") return value && !["unknown", "none", "not_visible", "unclear"].includes(value.toLowerCase()) ? display(value) : null;
  if (Array.isArray(value)) return value.map(populated).filter(Boolean).join(", ") || null;
  return null;
}
export function ObjectDetail({ object, images, notes }: {
  object: SourceObject;
  images: SecurityEvent["images"];
  notes: string[];
}) {
  const ai = object.analysis;
  const traits = Object.entries(ai?.person ?? ai?.vehicle ?? {}).flatMap(([field, value]) => {
    const text = populated(value);
    return text ? [{ field, text }] : [];
  });
  const refined = objectCategory(object);
  const actions = ai?.actions.filter((action) => action !== "unknown") ?? [];
  return (
    <section className="min-w-0 rounded-lg border p-3" aria-label={`NVR observation ${object.id}`}>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <Badge variant="outline">NVR · {display(object.category)}</Badge>
        {ai && refined.toLowerCase() !== display(object.category) && (
          <Badge variant="secondary">AI · <CategoryLabel category={refined} /></Badge>
        )}
      </div>
      <ObjectLocationDetails object={object}/>
      <div className="flex gap-3">
        {object.images.cropId && (
          <div className="h-32 w-24 shrink-0 overflow-hidden rounded bg-muted">
            <EventMedia image={images.find((image) => image.id === object.images.cropId)} />
          </div>
        )}
        <div className="min-w-0 flex-1 space-y-3">
          {ai ? (
            <>
              <div>
                <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">AI interpretation · {ai.verification}</p>
                <p className="text-sm font-medium">{ai.shortDescription || "No AI description available."}</p>
              </div>
              {actions.length > 0 && <div className="flex flex-wrap gap-1" aria-label="Accepted actions">{actions.map((action) => <Badge key={action} variant="secondary">{display(action)}</Badge>)}</div>}
              {traits.length > 0 && (
                <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                  {traits.map(({field, text}) => <div key={field}><dt className="text-muted-foreground">{fieldName(field)}</dt><dd>{text}</dd></div>)}
                </dl>
              )}
              {ai.relationship && <p className="text-xs">Relationship: {ai.relationship.kind} {ai.relationship.object === "other" ? "another object" : `a ${ai.relationship.object}`} <span className="text-muted-foreground">· AI interpretation</span></p>}
            </>
          ) : <p className="text-xs text-muted-foreground">No AI interpretation for this source observation.</p>}
        </div>
      </div>
      {ai && (
        <details className="mt-3 border-t pt-2 text-xs">
          <summary className="cursor-pointer text-muted-foreground">Confidence, evidence and uncertainty</summary>
          <div className="mt-3 space-y-3">
            <p className="text-muted-foreground">Scores are uncalibrated model assessments. Image numbers refer to the submitted evidence.</p>
            {ai.evidenceImages && <p>Object evidence: {ai.evidenceImages.join(", ")}</p>}
            <dl className="space-y-2">
              {Object.entries(ai.attributeEvidence ?? {}).map(([field, evidence]) => (
                <div key={field}>
                  <dt>{fieldName(field)}</dt>
                  <dd className="text-muted-foreground">{evidence.confidence === null ? "Confidence unknown" : `${evidence.confidence}% model confidence`} · {display(evidence.basis)}{evidence.evidenceImages.length > 0 ? ` · images ${evidence.evidenceImages.join(", ")}` : " · no cited images"}</dd>
                </div>
              ))}
            </dl>
            {ai.diagnostics && ai.diagnostics.length > 0 && (
              <div><h4 className="mb-1 font-medium">Application validation</h4><ul className="space-y-1">{ai.diagnostics.map((diagnostic, index) => <li key={index}>{fieldName(diagnostic.field)} · {display(diagnostic.code)}{diagnostic.rules?.length ? ` · ${diagnostic.rules.map(display).join(", ")}` : ""}</li>)}</ul></div>
            )}
            {notes.length > 0 && <div><h4 className="mb-1 font-medium">Uncertainty and other notes</h4><ul className="space-y-1">{notes.map((note) => <li key={note}>{note}</li>)}</ul></div>}
          </div>
        </details>
      )}
      <details className="mt-3 border-t pt-2 text-xs text-muted-foreground">
        <summary className="cursor-pointer">Technical source details</summary>
        <dl className="mt-2 space-y-2 break-all">
          <div><dt>Object UUID</dt><dd>{object.id}</dd></div>
          <div><dt>NVR source list</dt><dd>{object.sourceList}</dd></div>
          {object.notificationId && <div><dt>Notification UUID</dt><dd>{object.notificationId}</dd></div>}
          {object.sourceOrdinal !== undefined && <div><dt>Source ordinal</dt><dd>{object.sourceOrdinal}</dd></div>}
          {object.sourceCategoryCode && <div><dt>Source category code</dt><dd>{object.sourceCategoryCode}</dd></div>}
          {Object.entries(object.sourceIdentifiers ?? {}).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}
        </dl>
      </details>
    </section>
  );
}
