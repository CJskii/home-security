import { ExploreFilters } from './components/explore-filters';
import { exploreParams, exploreRange } from './lib/explore-filters';
import { mediaLoader } from "@/lib/media";
import { useState } from "react";
import {
  NavLink,
  Outlet,
  useLocation,
  useOutletContext,
  useSearchParams,
} from "react-router";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { z } from "zod";
import {
  Activity,
  ArrowUpRight,
  Camera,
  CarFront,
  CheckCheck,
  Compass,
  LayoutDashboard,
  LogOut,
  Menu,
  PersonStanding,
  RefreshCw,
  Settings,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { api, rangeParams, ApiError, formatTime, sessionEvents } from "@/lib/api";
import { camerasSchema, pageSchema, statisticsSchema } from "@/lib/contracts";
import { EventCard } from "@/components/event-card";
import { EventDetail } from "@/components/event-detail";
import { CameraPanel } from "@/components/camera-panel";
import { CameraSettingsPage } from "@/components/camera-settings";
import { useCameras, useConfigurationRefresh } from "@/lib/camera-configuration";
const sessionSchema = z.object({ authenticated: z.boolean() });
export function AuthGate() {
  const client = useQueryClient();
  const session = useQuery({
    queryKey: ["session"],
    queryFn: ({ signal }) => api("/api/session", sessionSchema, signal),
    retry: false,
    refetchInterval: 60_000,
    refetchOnWindowFocus: "always",
  });
  const [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  if (session.isPending)
    return (
      <main className="grid min-h-dvh place-items-center">
        <p role="status" className="text-sm text-muted-foreground">
          Connecting securely…
        </p>
      </main>
    );
  if (session.data?.authenticated && !(session.error instanceof ApiError && session.error.status === 401)) return <Shell />;
  return (
    <main className="grid min-h-dvh place-items-center p-6">
      <Card className="w-full max-w-sm">
        <CardContent className="space-y-6 p-6">
          <ShieldCheck className="size-9 text-primary" />
          <div>
            <h1 className="text-xl font-semibold">Home Security</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Sign in to review your home’s detections.
            </p>
          </div>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              void fetch("/api/session", {
                method: "POST",
                credentials: "same-origin",
                cache: "no-store",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ password }),
              })
                .then(async (r) => {
                  if (!r.ok)
                    throw new Error(
                      r.status === 429
                        ? "Too many attempts. Wait a minute before retrying."
                        : r.status === 404
                          ? "Dashboard sessions are not configured on this backend."
                          : "Sign-in failed. Check your password and origin configuration.",
                    );
                  setPassword("");
                  await client.invalidateQueries({ queryKey: ["session"] });
                })
                .catch((e: unknown) =>
                  setError(
                    e instanceof Error ? e.message : "Connection failed",
                  ),
                )
                .finally(() => setBusy(false));
            }}
          >
            <Label htmlFor="password">Dashboard password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              maxLength={256}
            />
            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
            {session.error instanceof ApiError &&
              session.error.status === 404 && (
                <p className="text-xs text-muted-foreground">
                  Configure the backend dashboard session settings first.
                </p>
              )}
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? "Signing in…" : "Sign in"}
            </Button>
          </form>
          <p className="text-xs text-muted-foreground">
            Private access · original NVR evidence
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
type Context = { camera: string; days: string; now: number };
const links = [
  { to: "/", label: "Overview", icon: LayoutDashboard },
  { to: "/explore", label: "Explore", icon: Compass },
  { to: "/cameras", label: "Cameras", icon: Camera },
  { to: "/settings", label: "Settings", icon: Settings },
];
function Shell() {
  const [collapsed, setCollapsed] = useState(false),
    [mobile, setMobile] = useState(false),
    [now, setNow] = useState(Date.now);
  const [search, setSearch] = useSearchParams(),
    location = useLocation(),
    client = useQueryClient();
  const camera = search.get("camera") ?? "all",
    days = ["1", "7", "30"].includes(search.get("days") ?? "")
      ? search.get("days")!
      : "1";
  const cameras = useQuery({
    queryKey: ["cameras"],
    refetchInterval:60_000,
    queryFn: ({ signal }) => api("/api/cameras", camerasSchema, signal),
  });
  const update = (key: string, value: string) => {
    const next = new URLSearchParams(search);
    next.set(key, value);
    if(key==="camera"&&z.uuid().safeParse(next.get("location")).success)next.delete("location");
    next.delete("event");
    setSearch(next);
  };
  const navigation = (compact: boolean) => (
    <div className="flex h-full flex-col">
      <div className="flex h-20 items-center gap-3 px-5">
        <div className="rounded-xl bg-primary/10 p-2">
          <ShieldCheck className="size-5 text-primary" />
        </div>
        {!compact && (
          <div>
            <p className="text-sm font-semibold tracking-tight">
              Home Security
            </p>
            <p className="text-[10px] text-muted-foreground">
              DETECTION WORKSPACE
            </p>
          </div>
        )}
      </div>
      <nav className="space-y-1 px-3">
        {links.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={{
              pathname: to,
              search: new URLSearchParams(
                [...search].filter(([k]) => k !== "event"),
              ).toString(),
            }}
            end={to === "/"}
            title={compact ? label : undefined}
            onClick={() => setMobile(false)}
            className={({ isActive }) =>
              `flex items-center gap-3 rounded-lg px-3 py-3 text-sm transition-colors ${isActive ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`
            }
          >
            <Icon className="size-4 shrink-0" />
            {!compact && label}
          </NavLink>
        ))}
      </nav>
      <div className="mt-auto space-y-3 p-5">
        {!compact && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            Uniview NVR
            <br />
            <span className="text-[10px]">Authoritative detection source</span>
          </p>
        )}
        <Button
          variant="ghost"
          size="icon"
          aria-label="Sign out"
          onClick={() => {
            void fetch("/api/session", {
              method: "DELETE",
              credentials: "same-origin",
            }).then((r) => {
              if (r.ok) {
                sessionEvents.dispatchEvent(new Event("ended"));
                mediaLoader.clear();
                client.clear();
                window.location.reload();
              }
            });
          }}
        >
          <LogOut className="size-4" />
        </Button>
      </div>
    </div>
  );
  return (
    <div className="flex min-h-dvh">
      <aside
        className={`sticky top-0 hidden h-dvh shrink-0 border-r bg-card/35 md:block ${collapsed ? "w-20" : "w-60"}`}
      >
        {navigation(collapsed)}
      </aside>
      <Sheet open={mobile} onOpenChange={setMobile}>
        <SheetContent side="left" className="w-64 p-0">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          {navigation(false)}
        </SheetContent>
      </Sheet>
      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-20 flex min-h-16 flex-wrap items-center gap-3 border-b bg-background/95 px-4 py-3 backdrop-blur lg:px-7">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Toggle navigation"
            onClick={() => {
              if (window.matchMedia("(min-width: 768px)").matches)
                setCollapsed(!collapsed);
              else setMobile(true);
            }}
          >
            <Menu className="size-4" />
          </Button>
          <span className="mr-auto hidden text-sm font-medium lg:block">
            Workspace <span className="mx-2 text-muted-foreground">/</span>
            {links.find((l) => l.to === location.pathname)?.label ?? "Overview"}
          </span>
          <Select value={camera} onValueChange={(v) => update("camera", v)}>
            <SelectTrigger className="w-36 text-xs" aria-label="Camera filter">
              <Camera className="size-3.5" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All cameras</SelectItem>
              {cameras.data?.cameras.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {location.pathname!=="/explore"&&<Select value={days} onValueChange={(v) => update("days", v)}>
            <SelectTrigger className="w-32 text-xs" aria-label="Date range">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1">Last 24 hours</SelectItem>
              <SelectItem value="7">Last 7 days</SelectItem>
              <SelectItem value="30">Last 30 days</SelectItem>
            </SelectContent>
          </Select>}
          <Button
            variant="ghost"
            size="icon"
            aria-label="Refresh data and date range"
            onClick={() => {
              setNow(Date.now());
              const next=new URLSearchParams(search);next.delete("at");setSearch(next,{replace:true});
              void client.invalidateQueries();
            }}
          >
            <RefreshCw className="size-4" />
          </Button>
        </header>
        <main className="mx-auto max-w-[1800px] space-y-7 p-4 lg:p-7">
          <Outlet context={{ camera, days, now } satisfies Context} />
        </main>
      </div>
    </div>
  );
}
function ErrorNotice({ error, retry }: { error: Error; retry: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4"
    >
      <p className="text-sm">{error.message}</p>
      <Button
        variant="outline"
        size="sm"
        onClick={
          error instanceof ApiError && error.status === 401
            ? () => window.location.reload()
            : retry
        }
      >
        {error instanceof ApiError && error.status === 401
          ? "Sign in"
          : "Retry"}
      </Button>
    </div>
  );
}
export function EventsPage({ overview = false }: { overview?: boolean }) {
  const { camera, days, now } = useOutletContext<Context>(),
    [search, setSearch] = useSearchParams();
  const range=overview?null:exploreRange(search,now);
  const params = overview?rangeParams(camera, days, now):exploreParams(search,camera,now);
  const filter = params.toString();
  const events = useInfiniteQuery({
    queryKey: ["events", overview ? "overview" : "explore", filter, range?.error??null],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => {
      const q = new URLSearchParams(filter);
      q.set("limit", overview ? "12" : "30");
      if (pageParam) q.set("cursor", pageParam);
      return api(`/api/events?${q}`, pageSchema, signal);
    },
    getNextPageParam: (last) =>
      overview ? undefined : (last.nextCursor ?? undefined),
    maxPages: 0,
    enabled: !range?.error,
  });
  const statistics = useQuery({
    queryKey: ["statistics", rangeParams(camera, days, now).toString()],
    queryFn: ({ signal }) =>
      api(
        `/api/dashboard/statistics?${rangeParams(camera, days, now)}`,
        statisticsSchema,
        signal,
      ),
    enabled: overview,
  });
  const rows = range?.error?[]:(events.data?.pages.flatMap((p) => p.events) ?? []),
    stats = statistics.data;
  const eventId = search.get("event");
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="mb-1 text-[10px] uppercase tracking-[.18em] text-primary">
            Your home, in focus
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">
            {overview ? "Security overview" : "Explore detections"}
          </h1>
          <p className="mt-2 text-xs text-muted-foreground">
            {overview
              ? "A clear picture of activity around your home."
              : "Every canonical NVR event, with or without AI enrichment."}{" "}
            · Europe/London
          </p>
        </div>
        <Badge variant="outline" className="gap-2 py-1.5">
          <span className="size-1.5 rounded-full bg-primary" />
          Original NVR detections
        </Badge>
      </div>
      {overview && (
        <>
          {statistics.isError && (
            <ErrorNotice
              error={statistics.error}
              retry={() => {
                void statistics.refetch();
              }}
            />
          )}
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {[
              {
                label: "Canonical events",
                value: stats?.total,
                icon: Activity,
                detail: "All captured events",
              },
              {
                label: "Person detections",
                value: stats?.person,
                icon: PersonStanding,
                detail: "Events containing a source person",
              },
              {
                label: "Motor vehicle detections",
                value: stats?.motorVehicle,
                icon: CarFront,
                detail: "Events containing a source motor vehicle",
              },
              {
                label: "AI completion",
                value: stats ? `${stats.completionPercentage}%` : undefined,
                icon: CheckCheck,
                detail: stats
                  ? `${stats.complete.toLocaleString()} of ${stats.total.toLocaleString()} events complete`
                  : "Of all canonical events",
              },
            ].map(({ label, value, icon: Icon, detail }) => (
              <Card key={label} className="gap-0 py-0">
                <CardContent className="p-5">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    {label}
                    <Icon className="size-4 text-primary/80" />
                  </div>
                  <div className="my-3 text-3xl font-semibold tracking-tight">
                    {value === undefined ? (
                      statistics.isError ? (
                        "—"
                      ) : (
                        <Skeleton className="h-9 w-20" />
                      )
                    ) : typeof value === "number" ? (
                      value.toLocaleString()
                    ) : (
                      value
                    )}
                  </div>
                  <p className="text-[10px] text-muted-foreground">{detail}</p>
                </CardContent>
              </Card>
            ))}
          </div>
          <p className="-mt-4 text-[10px] text-muted-foreground">
            Category totals overlap for mixed-object events. They count events,
            not unique people or vehicles.
          </p>
          <Card className="gap-0 py-0">
            <CardContent className="p-5">
              <div className="mb-5 flex flex-wrap justify-between gap-3">
                <div>
                  <h2 className="text-sm font-medium">Activity over time</h2>
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    {days === "1" ? "Hourly" : "24-hour"} event totals · source
                    event time
                  </p>
                </div>
                {stats && (
                  <div className="flex flex-wrap gap-2">
                    {[
                      ["Skipped", stats.skipped],
                      ["Failed", stats.failed],
                      ["Interrupted", stats.interrupted],
                      ["In progress", stats.pending],
                      ["No processing record", stats.missing],
                    ].map(([label, count]) => (
                      <Badge
                        key={label}
                        variant="secondary"
                        className="text-[10px]"
                      >
                        {label} {count}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
              {stats ? (
                <div
                  role="img"
                  aria-label={`Activity chart: ${stats.total} events in the selected period`}
                >
                  <div className="flex h-28 items-end gap-1 border-b">
                    {stats.activity.map((b) => (
                      <div
                        key={b.start}
                        className="group relative flex h-full flex-1 items-end"
                      >
                        <div
                          title={`${formatTime(b.start)}: ${b.count} events`}
                          className="w-full rounded-t-sm bg-primary/65 transition-colors hover:bg-primary"
                          style={{
                            height: `${Math.max(b.count ? 3 : 0, (b.count / Math.max(1, ...stats.activity.map((a) => a.count))) * 100)}%`,
                          }}
                        />
                      </div>
                    ))}
                  </div>
                  <div className="mt-2 flex justify-between text-[10px] text-muted-foreground">
                    <span>
                      {stats.activity[0] && formatTime(stats.activity[0].start)}
                    </span>
                    <span>{formatTime(new Date(now).toISOString())}</span>
                  </div>
                </div>
              ) : (
                <Skeleton className="h-32 w-full" />
              )}
            </CardContent>
          </Card>
        </>
      )}
      {!overview&&<ExploreFilters search={search} setSearch={next=>setSearch(next)} camera={camera} now={now}/>}
      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-medium">
              {overview ? "Recent detections" : "Event gallery"}
            </h2>
            <span className="text-xs text-muted-foreground">
              {rows.length} loaded
            </span>
          </div>
          {overview ? (
            <NavLink
              to={{ pathname: "/explore", search: search.toString() }}
              className="flex items-center gap-1 text-xs text-primary"
            >
              Explore all
              <ArrowUpRight className="size-3" />
            </NavLink>
          ) : (
            <span className="text-xs text-muted-foreground">{search.get('sort')==='oldest'?'Oldest first':'Newest first'}</span>
          )}
        </div>
        {events.isError && (
          <ErrorNotice
            error={events.error}
            retry={() => {
              void events.refetch();
            }}
          />
        )}
        <div className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {events.isPending&&!range?.error
            ? Array.from({ length: 8 }, (_, i) => (
                <Skeleton key={i} className="aspect-[4/3] rounded-xl" />
              ))
            : (overview ? rows.slice(0, 12) : rows).map((event) => (
                <EventCard
                  key={event.id}
                  mediaEnabled={!eventId}
                  event={event}
                  onOpen={() => {
                    const next = new URLSearchParams(search);
                    next.set("event", event.id);
                    setSearch(next, { preventScrollReset: true });
                  }}
                />
              ))}
        </div>
        {!events.isPending && !events.isError && rows.length === 0 && (
          <div className="rounded-xl border border-dashed py-20 text-center">
            <Compass className="mx-auto mb-3 size-7 text-muted-foreground" />
            <h3 className="text-sm">No detections in this view</h3>
            <p className="mt-2 text-xs text-muted-foreground">
              Try a wider time range or remove an active filter.
            </p>
          </div>
        )}
        {!overview && events.hasNextPage && (
          <div className="py-4 text-center">
            <Button
              variant="outline"
              disabled={events.isFetchingNextPage}
              onClick={() => {
                void events.fetchNextPage();
              }}
            >
              {events.isFetchingNextPage ? "Loading…" : "Load 30 more events"}
            </Button>
          </div>
        )}
      </section>
      {eventId && z.uuid().safeParse(eventId).success && (
        <EventDetail
          key={eventId}
          id={eventId}
          initial={rows.find((e) => e.id === eventId)}
          close={() => {
            const next = new URLSearchParams(search);
            next.delete("event");
            setSearch(next, { replace: true, preventScrollReset: true });
          }}
        />
      )}
    </>
  );
}
export function CamerasPage() {
  const [showZones, setShowZones] = useState(false);
  const { camera } = useOutletContext<Context>();
  const query = useCameras();
  const refresh = useConfigurationRefresh();
  const synchronized=query.data?.cameras.map(c=>c.synchronization);
  const lastSync=synchronized?.length && synchronized.every(s=>s?.lastSuccessfulAt)
    ? synchronized.map(s=>s!.lastSuccessfulAt!).sort()[0]:null;
  const stale=synchronized?.some(s=>s?.state!=='fresh');
  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold">Cameras</h1>
        <p className="mt-2 text-xs text-muted-foreground">
          Live substreams and NVR detection regions. Configure camera settings in Uniview.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button variant="outline" size="sm" aria-pressed={showZones} onClick={() => setShowZones(value => !value)}>Show zones</Button>
          <Button variant="outline" size="sm" disabled={refresh.pending || !query.data?.refreshAvailable} onClick={()=>refresh.mutate(undefined)}><RefreshCw className={refresh.isPending?'size-4 animate-spin':'size-4'} />{refresh.isPending?'Refreshing…':'Refresh camera configuration'}</Button>
          <span className="text-xs text-muted-foreground" role="status">{lastSync?`Last synced ${formatTime(lastSync)}${stale?' · stale':''}`:'No verified configuration sync'}</span>
        </div>
        {!query.isPending && !query.data?.refreshAvailable && <p className="mt-2 text-xs text-muted-foreground">Configuration refresh requires an upgraded receiver connection. Stored metadata remains available.</p>}
        {refresh.isError && <p role="alert" className="mt-2 text-xs text-destructive">Refresh failed. Last verified configuration retained. {refresh.error.message}</p>}
        {refresh.isSuccess && <p role="status" className="mt-2 text-xs text-muted-foreground">Camera configuration refreshed from the NVR.</p>}

      </div>
      {query.isError && (
        <ErrorNotice
          error={query.error}
          retry={() => {
            void query.refetch();
          }}
        />
      )}
      <div className="grid gap-5 xl:grid-cols-2">
        {query.isPending ? (
          <Skeleton className="h-96" />
        ) : (
          query.data?.cameras
            .filter((c) => camera === "all" || c.id === camera)
            .map((c) => <CameraPanel key={c.id} camera={c} showZones={showZones} />)
        )}
      </div>
    </>
  );
}
export function SettingsPage() {
  return <CameraSettingsPage />;
}
