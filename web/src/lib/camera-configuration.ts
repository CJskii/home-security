import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, sessionEvents } from "./api";
import { camerasSchema, streamsSchema, zonesSchema } from "./contracts";

export function useCameras() {
  return useQuery({ queryKey: ["cameras"], refetchInterval: 60_000,
    queryFn: ({ signal }) => api("/api/cameras", camerasSchema, signal) });
}
export function useCameraMetadata(id: string) {
  const streams = useQuery({ queryKey: ["streams", id], refetchInterval: 60_000,
    queryFn: ({ signal }) => api(`/api/cameras/${encodeURIComponent(id)}/streams`, streamsSchema, signal) });
  const zones = useQuery({ queryKey: ["zones", id], refetchInterval: 60_000,
    queryFn: ({ signal }) => api(`/api/cameras/${encodeURIComponent(id)}/zones`, zonesSchema, signal) });
  return { streams, zones };
}
export function useConfigurationRefresh() {
  const client = useQueryClient();
  const pending = useIsMutating({ mutationKey: ["camera-configuration-refresh"] }) > 0;
  const refresh = useMutation({ mutationKey: ["camera-configuration-refresh"],
    mutationFn: async (cameraId: string | undefined) => {
      const response = await fetch("/api/cameras/configuration/refresh", {
        method: "POST", credentials: "same-origin", cache: "no-store",
        ...(cameraId ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ cameraId }) } : {}),
      });
      if (!response.ok) {
        if (response.status === 401) sessionEvents.dispatchEvent(new Event("ended"));
        if (response.status === 409) throw new Error("A refresh is already running. Wait for it to finish.");
        throw new ApiError(response.status);
      }
    },
    // Partial NVR failures can still update the other channel and stale status.
    onSettled: async () => { await Promise.all(["cameras", "streams", "zones", "ai-processing", "events", "event"].map(key => client.invalidateQueries({ queryKey: [key] }))); },
  });
  return { ...refresh, pending: pending || refresh.isPending };
}
export function useZonePreferenceSave(cameraId: string, zoneId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (value: { displayName: string | null; interested: boolean; expectedGeometryFingerprint: string }) => {
      const response = await fetch(`/api/cameras/${encodeURIComponent(cameraId)}/zones/${encodeURIComponent(zoneId)}/preferences`, {
        method: 'PATCH', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
      });
      if (!response.ok) {
        if (response.status === 401) sessionEvents.dispatchEvent(new Event('ended'));
        if (response.status === 409) throw new Error('Zone geometry changed. Cancel and review the latest polygon before saving.');
        throw new ApiError(response.status);
      }
    },
    onSettled: async () => { await Promise.all([client.invalidateQueries({ queryKey: ['zones', cameraId] }),client.invalidateQueries({queryKey:['ai-processing']}),client.invalidateQueries({queryKey:['events']}),client.invalidateQueries({queryKey:['event']})]); },
  });
}
