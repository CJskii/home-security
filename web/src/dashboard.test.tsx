import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  MemoryRouter,
  Outlet,
  Route,
  Routes,
  useSearchParams,
} from "react-router";
import { ImageQueue, rangeParams, thumbnail } from "./lib/api";
import { eventSchema, type SecurityEvent } from "./lib/contracts";
import { AuthGate, EventsPage } from "./app";
import { EventCard } from "./components/event-card";
vi.mock("./components/event-media", () => ({
  EventMedia: () => <div>Original media placeholder</div>,
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const id = "17b01e57-cc3d-4db5-9bdd-f7d89e8149bb";
const imageId = "27b01e57-cc3d-4db5-9bdd-f7d89e8149bb";
function fixture(status = "SKIPPED"): SecurityEvent {
  return eventSchema.parse({
    id,
    camera: "camera_1",
    nvrChannel: 1,
    alarmType: "cross_line",
    timestamp: {
      value: "2026-10-19T13:00:00Z",
      source: "STRUCTURE_REPORTED_AT",
    },
    categories: ["person", "motor_vehicle"],
    processing: { status, reason: "capacity_exceeded" },
    images: [
      {
        id: imageId,
        type: 2,
        url: `/api/events/${id}/images/${imageId}`,
        width: 320,
        height: 544,
        capturedAt: null,
        availability: { state: "UNRESOLVED" },
      },
    ],
    objects: [
      {
        id: imageId,
        category: "person",
        sourceList: "PersonList",
        sourceCategoryCode: "1",
        images: { cropId: imageId, fullFrameId: null },
        rectangle: null,
        analysis: null,
      },
    ],
    analysis: null,
    truncated: { objects: false, images: false },
  });
}
it("uses original source-object crops and preserves mixed categories, skipped events and Structure time", () => {
  const event = fixture();
  expect(thumbnail(event)?.id).toBe(imageId);
  expect(event.categories).toEqual(["person", "motor_vehicle"]);
  expect(event.timestamp.source).toBe("STRUCTURE_REPORTED_AT");
  expect(event.processing?.status).toBe("SKIPPED");
  expect(event.objects[0]?.sourceCategoryCode).toBe("1");
  expect(thumbnail({ ...event, images: [] })).toBeUndefined();
  const frameOnly = {...event, images:event.images.map(image=>({...image,type:1})), objects:event.objects.map(object=>({...object,images:{cropId:null,fullFrameId:imageId}}))};
  expect(thumbnail(frameOnly)).toBeUndefined(); // Never download a full frame to fill a gallery card.
});
it("serializes image operations and discards aborted queued requests", async () => {
  const queue = new ImageQueue();
  let finish!: () => void;
  const first = queue.run(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    new AbortController().signal,
  );
  const operation = vi.fn(async () => "second");
  const controller = new AbortController();
  const second = queue.run(operation, controller.signal);
  const rejected = expect(second).rejects.toThrow();
  await Promise.resolve();
  expect(operation).not.toHaveBeenCalled();
  controller.abort();
  finish();
  await first;
  await rejected;
  expect(operation).not.toHaveBeenCalled();
  expect(await queue.run(operation, new AbortController().signal)).toBe(
    "second",
  );
});
it("uses UTC duration ranges across the London DST boundary", () => {
  const params = rangeParams(
    "camera_1",
    "1",
    Date.parse("2026-10-25T12:00:00Z"),
  );
  expect(params.get("occurredAfter")).toBe("2026-10-24T12:00:00.000Z");
  expect(params.get("camera")).toBe("camera_1");
});
function Context() {
  const [search] = useSearchParams();
  return (
    <>
      <output aria-label="Current query">{search.toString()}</output>
      <Outlet
        context={{
          camera: "camera_1",
          days: "7",
          now: Date.parse("2026-10-19T14:00:00Z"),
        }}
      />
    </>
  );
}
function mount(location="all") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter
        initialEntries={[`/explore?camera=camera_1&days=7&category=person&location=${location}`]}
      >
        <Routes>
          <Route element={<Context />}>
            <Route path="explore" element={<EventsPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}
it("keeps skipped events visible and retains gallery filters and cursor pages while opening details", async () => {
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      requests.push(input);
      const payload = input.startsWith("/api/events?")
        ? input.includes("cursor=")
          ? {
              events: [
                {
                  ...fixture("FAILED"),
                  id: "37b01e57-cc3d-4db5-9bdd-f7d89e8149bb",
                },
              ],
              nextCursor: null,
            }
          : { events: [fixture()], nextCursor: "opaque_cursor" }
        : fixture();
      return new Response(JSON.stringify(payload), {
        headers: { "content-type": "application/json" },
      });
    }),
  );
  const client = mount(imageId);
  expect(await screen.findByText("AI skipped · capacity")).toBeTruthy();
  await userEvent.click(
    screen.getByRole("button", { name: "Load 30 more events" }),
  );
  expect(await screen.findByText("AI failed")).toBeTruthy();
  expect(
    requests.some(
      (r) =>
        r.includes("cursor=opaque_cursor") &&
        r.includes(`locationZoneId=${imageId}`) &&
        r.includes("category=person") &&
        r.includes("camera=camera_1"),
    ),
  ).toBe(true);
  await userEvent.click(
    screen.getAllByRole("button", { name: /View event/ })[0]!,
  );
  expect(await screen.findByRole("dialog")).toBeTruthy();
  expect(screen.getByText("Detection details")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.getByText("AI failed")).toBeTruthy();
  expect(screen.getByLabelText("Current query").textContent).toBe(
    `camera=camera_1&days=7&category=person&location=${imageId}`,
  );
  client.clear();
});
it("shows a useful error state when the API fails instead of invented counts or events", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 503 })),
  );
  const client = mount();
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.getByText(/service is temporarily unavailable/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  client.clear();
});
it("requests only 12 Overview events independently of Explore cached pages", async () => {
  const filter = rangeParams(
    "camera_1",
    "7",
    Date.parse("2026-10-19T14:00:00Z"),
  ).toString();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(["events", "explore", filter], {
    pages: [
      { events: Array.from({ length: 90 }, () => fixture()), nextCursor: null },
    ],
    pageParams: [null],
  });
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      requests.push(input);
      return new Response(
        JSON.stringify(
          input.startsWith("/api/events?")
            ? {
                events: Array.from({ length: 12 }, (_, i) => ({
                  ...fixture(),
                  id: `${(i + 1).toString(16).padStart(8, "0")}-cc3d-4db5-9bdd-f7d89e8149bb`,
                })),
                nextCursor: "more",
              }
            : {
                total: 90,
                person: 20,
                motorVehicle: 80,
                complete: 60,
                skipped: 30,
                failed: 0,
                interrupted: 0,
                pending: 0,
                missing: 0,
                completionPercentage: 66.7,
                activity: [],
              },
        ),
      );
    }),
  );
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Routes>
          <Route element={<Context />}>
            <Route index element={<EventsPage overview />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  expect(await screen.findByText("12 loaded")).toBeTruthy();
  expect(screen.getAllByRole("button", { name: /View event/ })).toHaveLength(
    12,
  );
  expect(
    requests.some(
      (r) =>
        r.startsWith("/api/events?") &&
        new URL(r, "http://test").searchParams.get("limit") === "12",
    ),
  ).toBe(true);
  client.clear();
});

it("returns to sign-in after an expired session refetch despite previously authenticated query data", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: string) => new Response(JSON.stringify(input === "/api/session" ? {} : { cameras: [] }), {status:input === "/api/session" ? 401 : 200,headers:{"content-type":"application/json"}})));
  const client=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity}}});
  client.setQueryData(["session"],{authenticated:true});
  render(<QueryClientProvider client={client}><MemoryRouter><Routes><Route element={<AuthGate />}><Route index element={<p>Protected dashboard content</p>} /></Route></Routes></MemoryRouter></QueryClientProvider>);
  expect(await screen.findByText("Protected dashboard content")).toBeTruthy();
  await act(async()=>{await client.invalidateQueries({queryKey:["session"]});});
  expect(await screen.findByLabelText("Dashboard password")).toBeTruthy();
  expect(screen.queryByText("Protected dashboard content")).toBeNull();
  client.clear();
});
it('opens the HA other-zone link using the server-side cohort filter',async()=>{
 const requests:string[]=[];vi.stubGlobal('fetch',vi.fn(async(input:string)=>{requests.push(input);return new Response(JSON.stringify(input.startsWith('/api/events?')?{events:[fixture()],nextCursor:null}:fixture()),{headers:{'content-type':'application/json'}});}));const client=mount('other');expect(await screen.findByText('AI skipped · capacity')).toBeTruthy();expect(requests.some(r=>r.includes('zoneInterest=other')&&!r.includes('locationZoneId=other'))).toBe(true);client.clear();
});

it.each(["zone_not_selected", "zone_uncertain_not_selected", "zone_unmatched_not_selected"])("keeps the AI-not-selected badge without redundant description text for %s", reason => {
  const event = fixture(); event.processing = { status: "SKIPPED", reason };
  render(<EventCard event={event} onOpen={() => {}} />);
  expect(screen.getByText("AI not selected")).toBeTruthy();
  expect(screen.queryByText(/NVR detection|AI description unavailable|AI description skipped/)).toBeNull();
});
it.each(["capacity_exceeded", "eligibility_buffer_limit", "memory_limit"])("explains why the AI description was skipped for %s", reason => {
  const event = fixture(); event.processing = { status: "SKIPPED", reason };
  render(<EventCard event={event} onOpen={() => {}} />);
  expect(screen.getByText("AI description skipped due to limited processing capacity.")).toBeTruthy();
  expect(screen.queryByText(/NVR detection|AI description unavailable/)).toBeNull();
});
it("shows an available description ahead of capacity fallback wording", () => {
  const event = fixture(); event.analysis = { shortDescription: "A person appears to be walking.", uncertainties: [], model: "fixture", promptVersion: 5, schemaVersion: 3 };
  render(<EventCard event={event} onOpen={() => {}} />);
  expect(screen.getByText("A person appears to be walking.")).toBeTruthy();
  expect(screen.queryByText(/AI description skipped/)).toBeNull();
});
it.each(["PENDING", "FAILED", "COMPLETE"])("uses the status badge without inventing unavailable-description text for %s", status => {
  render(<EventCard event={fixture(status)} onOpen={() => {}} />);
  expect(screen.queryByText(/NVR detection|AI description unavailable|AI description skipped/)).toBeNull();
});
