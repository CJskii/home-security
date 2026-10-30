import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ImageOff, LoaderCircle } from "lucide-react";
import { mediaLoader, validMediaPath } from "@/lib/media";
import type { EventImage } from "@/lib/contracts";
import { Button } from "@/components/ui/button";
export function EventMedia({
  image,
  onLoaded,
  emptyLabel = "No original image",
  children,
}: {
  image?: EventImage;
  onLoaded?: () => void;
  emptyLabel?: string;
  children?: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const path = image?.url && validMediaPath(image.url) && image.url.endsWith(`/images/${image.id}`) ? image.url : undefined;
  const url = useSyncExternalStore(
    useCallback((listener) => mediaLoader.subscribe(path, listener), [path]),
    useCallback(() => mediaLoader.getCached(path), [path]),
  );
  const [visible, setVisible] = useState(false);
  const [result, setResult] = useState<{ path?: string; error?: string; pending: boolean }>({ pending: false });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(!!entry?.isIntersecting),
      // Only crops prefetch ahead. Full frames remain viewer-demanded.
      { rootMargin: image?.type === 2 ? "300px 0px" : "0px" },
    );
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, [image?.type]);
  useEffect(() => {
    if (!path || !visible) return;
    const controller = new AbortController();
    setResult({ path, pending: true });
    const priority = () => {
      const bounds = ref.current?.getBoundingClientRect();
      return bounds && bounds.bottom > 0 && bounds.top < window.innerHeight ? 1 : 0;
    };
    void mediaLoader.load(path, controller.signal, priority).then(() => {
      if (!controller.signal.aborted) setResult({ path, pending: false });
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setResult({ path, pending: false, error: cause instanceof Error ? cause.message : "Image unavailable" });
    });
    return () => controller.abort();
  }, [path, visible, attempt]);
  const error = image?.url && !path ? "Invalid media reference" : result.path === path ? result.error : undefined;
  const released = !!path && result.path === path && !result.pending && !url && !error;
  return (
    <div
      ref={ref}
      className="relative flex h-full min-h-32 w-full items-center justify-center overflow-hidden bg-black/25"
    >
      {url ? (
        <>
          <img
            src={url}
            alt="Original NVR event image"
            onLoad={onLoaded}
            loading="lazy"
            decoding="async"
            className="block h-full w-full object-contain"
          />
          {children}
        </>
      ) : (
        <div className="flex flex-col items-center gap-2 p-4 text-center text-xs text-muted-foreground">
          {!image ? (
            <>
              <ImageOff className="size-5" />
              {emptyLabel}
            </>
          ) : error || released ? (
            <>
              <ImageOff className="size-5" />
              {error ?? "Image released from memory"}
              <Button
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  setAttempt((n) => n + 1);
                }}
              >
                Retry
              </Button>
            </>
          ) : (
            <>
              <LoaderCircle className="size-4 animate-spin" />
              Loading original
            </>
          )}
        </div>
      )}
    </div>
  );
}
