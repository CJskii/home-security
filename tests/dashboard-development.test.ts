import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { developmentConfig } from "../src/dashboard/development-config.js";
import {
  readOnlyConnectionString,
  READ_ONLY_OPTIONS,
} from "../src/dashboard/development-database.js";
import { buildDevelopmentApp } from "../src/dashboard/development.js";
import { createDevelopmentMedia } from "../src/dashboard/development-media.js";
import type {
  HistoricalImageStore,
  ResolutionEvent,
} from "../src/uniview/historical-image-resolution.js";
import { config, jpeg } from "./uniview-fixtures.js";
const id = "17b01e57-cc3d-4db5-9bdd-f7d89e8149bb",
  imageId = "27b01e57-cc3d-4db5-9bdd-f7d89e8149bb";
const source = {
  DATABASE_URL: "postgresql://test:secret@docker-db:5432/security_events",
  UNIVIEW_INSTALLATION_ID: config.UNIVIEW_INSTALLATION_ID!,
  UNIVIEW_NVR_IP: "192.168.50.30",
  UNIVIEW_USERNAME: "test",
  UNIVIEW_PASSWORD: "secret",
  UNIVIEW_CAMERA_MAP: '{"1":"camera_1"}',
  LIVE_GATEWAY_ENABLED: "true",
  AI_ENABLED: "true",
  UNIVIEW_ENABLED: "true",
  EVENTS_TOKEN: "e".repeat(32),
};
const local = {
  DEV_DATABASE_HOST: "172.20.0.10",
  DEV_LAN_IP: "192.168.50.10",
  DASHBOARD_PASSWORD: "d".repeat(48),
  DASHBOARD_SESSION_KEY: "ab".repeat(32),
};
const instances: ReturnType<typeof buildDevelopmentApp>[] = [];
afterEach(async () => {
  await Promise.all(instances.splice(0).map((s) => s.app.close()));
});
it("whitelists source configuration, isolates the API and forces every database connection read-only", () => {
  const c = developmentConfig(source, local);
  expect(c).toMatchObject({
    HOST: "127.0.0.1",
    PORT: 3001,
    NODE_ENV: "development",
    LIVE_GATEWAY_ENABLED: false,
    AI_ENABLED: false,
    UNIVIEW_ENABLED: false,
    UNIVIEW_SAMPLING_ENABLED: false,
    METRICS_ENABLED: false,
    DASHBOARD_ORIGIN: "http://127.0.0.1:5173",
  });
  expect(developmentConfig(source, { ...local, LIVE_GATEWAY_ENABLED: "true" }).LIVE_GATEWAY_ENABLED).toBe(true);
  expect(c.EVENTS_TOKEN).toBeUndefined();
  expect(c.UNIVIEW_PASSWORD).toBe("secret");
  const url = new URL(
    readOnlyConnectionString(
      c.DATABASE_URL + "?options=-c%20default_transaction_read_only=off",
    ),
  );
  expect(url.hostname).toBe("172.20.0.10");
  expect(url.searchParams.get("options")).toBe(READ_ONLY_OPTIONS);
  expect(developmentConfig(source, local, true).DASHBOARD_ORIGIN).toBe(
    "https://192.168.50.10:5173",
  );
  expect(() =>
    developmentConfig(source, { ...local, DEV_DATABASE_HOST: "" }),
  ).toThrow();
});
function mediaFixture(stored = true) {
  const bytes = Buffer.from(jpeg),
    hash = createHash("sha256").update(bytes).digest("hex"),
    time = new Date("2026-10-19T12:00:00Z");
  const event: ResolutionEvent = {
    id,
    sourceInstallationId: source.UNIVIEW_INSTALLATION_ID,
    nvrChannel: 1,
    alarmType: "EnterArea",
    notifications: [
      {
        id: imageId,
        eventId: id,
        reportedAt: time,
        metadata: {
          StructureInfo: {
            ObjInfo: { PersonInfoList: [{ LargePicAttachIndex: 1 }] },
          },
        },
      },
    ],
    snapshots: [
      {
        id: imageId,
        eventId: id,
        notificationId: imageId,
        origin: "NVR_PUSH",
        status: "RECEIVED",
        imageType: "1",
        sha256: hash,
        sourceImageIndex: 1,
        capturedAt: time,
        nvrPictureName: stored ? "original" : null,
        nvrPictureSize: stored ? bytes.length : null,
        nvrPictureType: stored ? 1 : null,
        nvrRecordId: null,
        referenceVersion: 0,
        referenceResolvedAt: stored ? time : null,
      },
    ],
  };
  const store: HistoricalImageStore = {
    load: vi.fn(async () => structuredClone(event)),
    save: vi.fn(async () => {
      throw new Error("No writes permitted");
    }),
  };
  const client = {
    historicalPicture: vi.fn(async () => bytes),
    searchObjects: vi.fn(async () => [
      {
        RecordID: "record",
        Type: 2,
        Time: time.getTime() / 1000,
        ChannelID: 1,
        FullPicture: { Name: "original", Size: bytes.length },
        ObjectList: [
          {
            ObjectID: 1,
            ObjectPicture: { Name: "crop", Size: bytes.length },
            ObjectInfo: { ObjectType: 2 },
          },
        ],
      },
    ]),
  };
  return {
    event,
    store,
    client,
    bytes,
    media: createDevelopmentMedia(
      developmentConfig(source, local),
      store,
      client,
    ),
  };
}
it.each([true, false])(
  "serves hash-verified originals without persistent save calls (stored=%s)",
  async (stored) => {
    const f = mediaFixture(stored);
    expect(await f.media.image(id, imageId)).toEqual(f.bytes);
    expect(f.store.save).not.toHaveBeenCalled();
    expect(f.event.snapshots[0]?.referenceVersion).toBe(0);
    expect(f.client.searchObjects).toHaveBeenCalledTimes(stored ? 0 : 1);
    await f.media.close();
  },
);
it("rejects mismatches and ownership errors without writes or substituting a live snapshot", async () => {
  const f = mediaFixture();
  f.client.historicalPicture.mockResolvedValue(
    Buffer.concat([
      f.bytes.subarray(0, 26),
      Buffer.from([17]),
      f.bytes.subarray(27),
    ]),
  );
  await expect(f.media.image(id, imageId)).rejects.toMatchObject({
    code: "IMAGE_INTEGRITY_MISMATCH",
  });
  expect(f.store.save).not.toHaveBeenCalled();
  f.event.sourceInstallationId = imageId;
  f.client.historicalPicture.mockClear();
  await expect(f.media.image(id, imageId)).rejects.toMatchObject({
    status: 404,
  });
  expect(f.client.historicalPicture).not.toHaveBeenCalled();
  await f.media.close();
});
it("blocks every non-session mutation before services run, even after session login", async () => {
  const f = mediaFixture(),
    database = {
      historicalImages: f.store,
      checkReady: vi.fn(),
      disconnect: vi.fn(),
    };
  const service = buildDevelopmentApp(
    { ...developmentConfig(source, local), LOG_LEVEL: "silent" },
    database,
    f.media,
  );
  instances.push(service);
  const response = await service.app.inject({
    method: "POST",
    url: "/api/session",
    headers: { origin: "http://127.0.0.1:5173" },
    payload: { password: local.DASHBOARD_PASSWORD },
  });
  expect(response.statusCode).toBe(200);
  expect(response.cookies[0]?.secure).not.toBe(true);
  const cookie = response.cookies[0]!,
    headers = { cookie: `${cookie.name}=${encodeURIComponent(cookie.value)}` };
  for (const [method, url] of [
    ["POST", `/api/events/${id}/enrich`],
    ["POST", "/api/cameras/zones/refresh"],
    ["PATCH", `/api/cameras/camera_1/zones/${imageId}`],
  ] as const)
    expect(
      (await service.app.inject({ method, url, headers, payload: {} }))
        .statusCode,
    ).toBe(405);
  expect(f.store.save).not.toHaveBeenCalled();
  expect(f.client.historicalPicture).not.toHaveBeenCalled();
  expect(
    (await service.app.inject({ url: "/api/cameras", headers })).statusCode,
  ).toBe(200);
  expect((await service.app.inject({ url: "/api/cameras" })).statusCode).toBe(
    401,
  );
});

it("bounds development requests at two, serializes cold work and never saves failures", async () => {
  const f = mediaFixture();
  let rejectPicture!: (error: Error) => void;
  f.client.historicalPicture.mockImplementation(
    () =>
      new Promise<typeof f.bytes>((_resolve, reject) => {
        rejectPicture = reject;
      }),
  );
  const first = f.media.image(id, imageId);
  const failed = expect(first).rejects.toMatchObject({ status: 503 });
  await vi.waitFor(() =>
    expect(f.client.historicalPicture).toHaveBeenCalledOnce(),
  );
  const second = f.media.image(id, imageId);
  const secondFailure = expect(second).rejects.toMatchObject({ status: 503 });
  await expect(f.media.image(id, imageId)).rejects.toMatchObject({
    code: "NVR_BUSY",
  });
  f.client.historicalPicture.mockRejectedValue(new Error("synthetic failure"));
  rejectPicture(new Error("synthetic transport failure"));
  await failed;
  await secondFailure;
  expect(f.store.save).not.toHaveBeenCalled();
  await f.media.close();
});

it("reuses only reference metadata, downloads/rechecks originals on repeats and expires references", async () => {
  const f = mediaFixture(false);
  let clock = 0;
  const media = createDevelopmentMedia(
    developmentConfig(source, local),
    f.store,
    f.client,
    () => clock,
  );
  expect(await media.image(id, imageId)).toEqual(f.bytes);
  expect(await media.image(id, imageId)).toEqual(f.bytes);
  expect(f.client.searchObjects).toHaveBeenCalledTimes(1);
  expect(f.client.historicalPicture).toHaveBeenCalledTimes(2);
  clock = 5 * 60_000 + 1;
  await media.image(id, imageId);
  expect(f.client.searchObjects).toHaveBeenCalledTimes(2);
  expect(f.store.save).not.toHaveBeenCalled();
  await media.close();
});
it("invalidates memoized references when source metadata changes and never caches JPEG bytes", async () => {
  const f = mediaFixture(false);
  await f.media.image(id, imageId);
  const changed = Buffer.from(f.bytes);
  changed[26] = 17;
  f.event.snapshots[0]!.sha256 = createHash("sha256")
    .update(changed)
    .digest("hex");
  f.client.historicalPicture.mockResolvedValue(changed);
  expect(await f.media.image(id, imageId)).toEqual(changed);
  expect(f.client.searchObjects).toHaveBeenCalledTimes(2);
  expect(f.store.save).not.toHaveBeenCalled();
  await f.media.close();
});
it("opts into fixed receiver forwarding without enabling development writes or receiver workers", async () => {
  const f = mediaFixture();
  const config = developmentConfig(source, {...local,CAMERA_SYNC_OWNER_URL:'http://127.0.0.1:18080/',CAMERA_SYNC_TOKEN:'s'.repeat(32)});
  const request=vi.fn<typeof fetch>(async()=>Response.json({channels:[{channel:1,status:'SYNCED'},{channel:2,status:'SYNCED'}]}));
  vi.stubGlobal('fetch',request);
  try {
    const service=buildDevelopmentApp(config,{historicalImages:f.store,checkReady:async()=>{},disconnect:async()=>{}},f.media);instances.push(service);
    const login=await service.app.inject({method:'POST',url:'/api/session',headers:{origin:config.DASHBOARD_ORIGIN!},payload:{password:config.DASHBOARD_PASSWORD}});
    const headers={cookie:login.headers['set-cookie'] as string,origin:config.DASHBOARD_ORIGIN!};
    expect((await service.app.inject({method:'POST',url:'/api/cameras/configuration/refresh',headers})).statusCode).toBe(200);
    expect(request).toHaveBeenCalledOnce();expect(String(request.mock.calls[0]![0])).toBe('http://127.0.0.1:18080/internal/cameras/configuration/refresh');
    expect((await service.app.inject({method:'POST',url:`/api/events/${id}/enrich`,headers})).statusCode).toBe(405);
    expect(f.store.save).not.toHaveBeenCalled();expect(f.client.historicalPicture).not.toHaveBeenCalled();
    expect(config.UNIVIEW_ENABLED).toBe(false);expect(config.AI_ENABLED).toBe(false);expect(config.EVENTS_TOKEN).toBeUndefined();
  } finally {vi.unstubAllGlobals();}
});

it('uses an explicitly configured LAN host and fails closed without a valid address', () => {
  expect(developmentConfig(source, { ...local, DEV_LAN_IP: '192.168.50.90' }, true).DASHBOARD_ORIGIN).toBe('https://192.168.50.90:5173');
  expect(() => developmentConfig(source, { ...local, DEV_LAN_IP: '' }, true)).toThrow();
  expect(() => developmentConfig(source, { ...local, DEV_LAN_IP: '0.0.0.0;command' }, true)).toThrow();
  expect(developmentConfig(source, { ...local, DEV_LAN_IP: '' }).DASHBOARD_ORIGIN).toBe('http://127.0.0.1:5173');
});
