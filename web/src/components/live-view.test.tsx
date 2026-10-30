import { act, render, screen, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LiveView } from "./live-view";
import { LivePlayer } from "@/lib/live-player";
import { sessionEvents } from "@/lib/api";
const connect = vi.spyOn(LivePlayer.prototype, "onconnect").mockReturnValue(false);
const stop = vi.spyOn(LivePlayer.prototype, "stop");
beforeEach(() => {
  vi.stubGlobal("MediaSource", { isTypeSupported: () => true });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("handles an unconfigured gateway without opening a player", () => {
  render(<LiveView endpoint={null} name="Driveway" />);
  expect(screen.getByText("Live gateway not configured")).toBeTruthy();
  expect(connect).not.toHaveBeenCalled();
});
it("uses a same-origin source, stops on logout and unmount, and does not leak upstream errors", () => {
  const { unmount } = render(<LiveView endpoint="/api/live/ws?src=camera_1_sub" name="Driveway" height={720} />);
  const player = document.querySelector("security-live") as LivePlayer;
  expect(player.wsURL).toContain("/api/live/ws?src=camera_1_sub");
  act(() => player.report("playing"));
  expect(screen.getByText("LIVE")).toBeTruthy();
  expect(screen.getByText("H.264 · 720p · Substream")).toBeTruthy();
  const status = screen.getByLabelText("Driveway live status");
  expect(status.contains(screen.getByText("LIVE"))).toBe(true);
  expect(status.contains(screen.getByLabelText("Expand Driveway"))).toBe(true);
  expect(screen.getAllByLabelText("Expand Driveway")).toHaveLength(1);
  expect(player.contains(status)).toBe(false);
  expect(player.parentElement?.parentElement?.nextElementSibling).toBe(status);
  expect(player.video.controls).toBe(false);
  act(() => { sessionEvents.dispatchEvent(new Event("ended")); });
  expect(stop).toHaveBeenCalled();
  unmount();
  expect(document.querySelector("security-live")).toBeNull();
  expect(player.ws).toBeNull();
});
it("rejects arbitrary endpoints and tears down when the source changes", () => {
  const view = render(<LiveView endpoint="/api/live/ws?src=camera_2_sub" name="Garden" />);
  expect(document.querySelector("security-live")).toBeTruthy();
  view.rerender(<LiveView endpoint="https://evil.test/api/ws" name="Garden" />);
  expect(document.querySelector("security-live")).toBeNull();
  expect(stop).toHaveBeenCalled();
});
it("stops before a page is frozen and recreates the player on back/forward-cache restoration", () => {
  render(<LiveView endpoint="/api/live/ws?src=camera_1_sub" name="Driveway" />);
  const first = document.querySelector("security-live") as LivePlayer;
  act(() => {
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
  });
  expect(stop).toHaveBeenCalled();
  expect(first.ws).toBeNull();
  act(() => {
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  });
  expect(document.querySelector("security-live")).not.toBe(first);
  expect(document.querySelectorAll("security-live")).toHaveLength(1);
});

it("toggles fullscreen and follows browser Escape without recreating the player", async () => {
  const { fireEvent } = await import("@testing-library/react");
  const originalFullscreen = Object.getOwnPropertyDescriptor(document, "fullscreenElement");
  const originalExit = Object.getOwnPropertyDescriptor(document, "exitFullscreen");
  try {
    render(<LiveView endpoint="/api/live/ws?src=camera_1_sub" name="Driveway" />);
    const player = document.querySelector("security-live") as LivePlayer;
    act(() => player.report("playing"));
    const root = screen.getByLabelText("Driveway live status").parentElement!;
    const change = (element: Element | null) => {
      Object.defineProperty(document, "fullscreenElement", { configurable: true, value: element });
      document.dispatchEvent(new Event("fullscreenchange"));
    };
    Object.defineProperty(root, "requestFullscreen", { value: vi.fn(async () => change(root)) });
    Object.defineProperty(document, "exitFullscreen", { configurable: true, value: vi.fn(async () => change(null)) });
    const connections = connect.mock.calls.length;
    await act(async () => { fireEvent.click(screen.getByLabelText("Expand Driveway")); });
    expect(screen.getByLabelText("Exit fullscreen Driveway").getAttribute("aria-pressed")).toBe("true");
    await act(async () => { fireEvent.click(screen.getByLabelText("Exit fullscreen Driveway")); });
    expect(screen.getByLabelText("Expand Driveway")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByLabelText("Expand Driveway")); });
    act(() => change(null)); // Native Escape changes fullscreen state externally.
    expect(screen.getByLabelText("Expand Driveway").getAttribute("aria-pressed")).toBe("false");
    expect(document.querySelector("security-live")).toBe(player);
    expect(connect.mock.calls.length).toBe(connections);
  } finally {
    if (originalFullscreen) Object.defineProperty(document, "fullscreenElement", originalFullscreen);
    else Reflect.deleteProperty(document, "fullscreenElement");
    if (originalExit) Object.defineProperty(document, "exitFullscreen", originalExit);
    else Reflect.deleteProperty(document, "exitFullscreen");
  }
});

it("toggles only valid enabled overlays while keeping the same video and connection lifecycle", () => {
  const zone = { id: "zone", name: "Driveway region", slot: 0, current: { enabled: true, ruleEnabled: true, observedAt: "", polygon: [{ X: 0, Y: 0 }, { X: 10000, Y: 0 }, { X: 10000, Y: 10000 }, { X: 0, Y: 10000 }] } };
  const props = { endpoint: "/api/live/ws?src=camera_1_sub", name: "Driveway", zones: [zone, { ...zone, id: "disabled", name: "Disabled region", slot: 1, current: { ...zone.current, enabled: false } }] };
  const view = render(<LiveView {...props} />);
  const player = document.querySelector("security-live") as LivePlayer;
  const video = player.video;
  Object.defineProperty(video, "videoWidth", { value: 1280 });
  Object.defineProperty(video, "videoHeight", { value: 720 });
  act(() => player.report("playing"));
  const connections = connect.mock.calls.length;
  view.rerender(<LiveView {...props} showZones />);
  expect(screen.getByRole("img").querySelectorAll("polygon")).toHaveLength(1);
  expect(screen.getByLabelText("Driveway visible detection zones").textContent).toContain("Driveway region");
  expect(screen.queryByText("Disabled region")).toBeNull();
  view.rerender(<LiveView {...props} showZones={false} />);
  expect(screen.queryByRole("img")).toBeNull();
  expect(document.querySelector("security-live")).toBe(player);
  expect(player.video).toBe(video);
  view.rerender(<LiveView {...props} name="Updated NVR name" showZones zones={[{...zone,current:{...zone.current,polygon:[...zone.current.polygon.slice(0,2),{X:7000,Y:5000},...zone.current.polygon.slice(2)]}}]} />);
  expect(screen.getByRole("img").querySelector("polygon")?.getAttribute("points")?.split(" ")).toHaveLength(5);
  expect(document.querySelector("security-live")).toBe(player);
  expect(player.video).toBe(video);
  expect(connect.mock.calls.length).toBe(connections);
});
