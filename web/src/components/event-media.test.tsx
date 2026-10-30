import { mediaLoader } from "@/lib/media";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, act } from "@testing-library/react";
import { EventMedia } from "./event-media";
import type { EventImage } from "@/lib/contracts";
const id = "17b01e57-cc3d-4db5-9bdd-f7d89e8149bb";
const image: EventImage = {
  id,
  type: 2,
  url: `/api/events/${id}/images/${id}`,
  width: 1,
  height: 1,
  capturedAt: null,
  availability: { state: "UNRESOLVED" },
};
afterEach(() => {
  cleanup();
  mediaLoader.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function observer() {
  let visible!: (entries: { isIntersecting: boolean }[]) => void;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: typeof visible) {
        visible = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  return (value: boolean) => act(() => visible([{ isIntersecting: value }]));
}
it("fetches only visible original media with session credentials, then retains its session-owned URL offscreen and on remount", async () => {
  const visibility = observer(),
    fetcher = vi.fn(
      async () =>
        new Response(new Uint8Array([255, 216, 255, 217]), {
          headers: { "content-type": "image/jpeg" },
        }),
    );
  vi.stubGlobal("fetch", fetcher);
  const create = vi.fn(() => "blob:synthetic"),
    revoke = vi.fn();
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: create,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: revoke,
  });
  const view = render(<EventMedia image={image} />);
  expect(fetcher).not.toHaveBeenCalled();
  visibility(true);
  expect(await screen.findByRole("img")).toBeTruthy();
  expect(fetcher).toHaveBeenCalledWith(
    image.url,
    expect.objectContaining({ credentials: "same-origin", cache: "no-store" }),
  );
  visibility(false);
  expect(revoke).not.toHaveBeenCalled();
  expect(screen.getByRole("img").getAttribute("src")).toBe("blob:synthetic");
  visibility(true);
  view.unmount();
  expect(revoke).not.toHaveBeenCalled();
  render(<EventMedia image={image} />);
  // Synchronous snapshot before IntersectionObserver fires or any promise resolves.
  expect(screen.getByRole("img").getAttribute("src")).toBe("blob:synthetic");
  expect(fetcher).toHaveBeenCalledOnce();
  expect(create).toHaveBeenCalledOnce();
  act(() => mediaLoader.clear());
  expect(revoke).toHaveBeenCalledWith("blob:synthetic");
  expect(screen.queryByRole("img")).toBeNull();
});
it("shows an explicit missing-media placeholder without any fetch", () => {
  observer();
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  render(<EventMedia />);
  expect(screen.getByText("No original image")).toBeTruthy();
  expect(fetcher).not.toHaveBeenCalled();
});
it("labels transient NVR busy responses without claiming expiry or retrying automatically", async () => {
  const visibility = observer(),
    fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: "NVR_BUSY" }), { status: 503 }),
    );
  vi.stubGlobal("fetch", fetcher);
  render(<EventMedia image={image} />);
  visibility(true);
  expect(await screen.findByText("NVR busy · retry shortly")).toBeTruthy();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
});
it("retries a failed original explicitly without caching the failure", async () => {
  const visibility = observer();
  const fetcher = vi.fn().mockResolvedValueOnce(new Response('{"code":"NVR_BUSY"}',{status:503})).mockImplementation(async()=>new Response(new Uint8Array([255,216,255,217]),{headers:{"content-type":"image/jpeg"}}));
  vi.stubGlobal("fetch",fetcher);
  Object.defineProperty(URL,"createObjectURL",{configurable:true,value:vi.fn(()=>"blob:retry")});
  Object.defineProperty(URL,"revokeObjectURL",{configurable:true,value:vi.fn()});
  render(<EventMedia image={image} />);visibility(true);
  expect(await screen.findByText("NVR busy · retry shortly")).toBeTruthy();
  const user=(await import("@testing-library/user-event")).default;
  await user.click(screen.getByRole("button",{name:"Retry"}));
  expect(await screen.findByRole("img")).toBeTruthy();expect(fetcher).toHaveBeenCalledTimes(2);
});
