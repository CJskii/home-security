import { createZoneActivity } from './zone-activity.js';
import type {DeliveryStore} from '../notifications/destination.js';
import { createNotificationStore, type NotificationStore } from '../notifications/store.js';
import { createProcessingProposalStore,type ProcessingProposalStore } from '../ai/processing-proposal.js';
import { createCameraConfigurationStore } from '../uniview/camera-configuration.js';
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";
import type { Config } from "../config.js";
import type { Database } from "../database.js";
import { createEventQueries } from "../events/store.js";
import { createHistoricalImageStore } from "../uniview/historical-image-store.js";
import { createZoneStore } from "../uniview/zone-store.js";
import { createStatistics } from "./statistics.js";
import { createZonePreferenceStore, type ZonePreferenceStore } from '../uniview/zone-preferences.js';
export const READ_ONLY_OPTIONS =
  "-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=5000";
export function readOnlyConnectionString(value: string): string {
  const url = new URL(value);
  // URL options otherwise override pg's constructor options. Force every connection.
  url.searchParams.set("options", READ_ONLY_OPTIONS);
  return url.toString();
}
export function createDevelopmentDatabase(config: Config, preferenceWriter?: ZonePreferenceStore['save'],processingWriter?:ProcessingProposalStore['save'], notificationWriter:Pick<NotificationStore,'save'|'archive'>={},deliveryClient?:DeliveryStore): Database {
  const adapter = new PrismaPg({
    connectionString: readOnlyConnectionString(config.DATABASE_URL),
    max: 2,
    connectionTimeoutMillis: 3000,
    query_timeout: 6000,
    idleTimeoutMillis: 10000,
    application_name: "home-security-dashboard-dev",
  });
  const prisma = new PrismaClient({ adapter, log: [] });
  const rejectWrite = async (): Promise<never> => {
    throw new Error("Development database is read-only");
  };
  const images = createHistoricalImageStore(prisma),
    zones = createZoneStore(prisma,undefined,Boolean(config.CAMERA_SYNC_OWNER_URL));
  const notifications=createNotificationStore(prisma,config);
  return {
    ...(deliveryClient?{notificationDelivery:deliveryClient}:{}),
    notifications:{...(notifications.history?{history:notifications.history}:{}),read:notifications.read,evaluation:notifications.evaluation,preview:notifications.preview,...notificationWriter},
    processingProposal:{read:createProcessingProposalStore(prisma).read,...(processingWriter?{save:processingWriter}:{})},
    zonePreferences: { list: createZonePreferenceStore(prisma).list, ...(preferenceWriter ? {save:preferenceWriter} : {}) },
    ...(config.CAMERA_SYNC_OWNER_URL ? {cameraConfiguration:{get:createCameraConfigurationStore(prisma).get,observe:rejectWrite,failed:rejectWrite}}:{}),
    events: createEventQueries(prisma),
    zoneActivity: createZoneActivity(prisma),
    statistics: createStatistics(prisma),
    historicalImages: { load: images.load, save: rejectWrite },
    zones: { list: zones.list, observe: rejectWrite, rename: rejectWrite },
    async checkReady() {
      const [state] = await prisma.$queryRaw<
        { database: string; readonly: string; defaultReadonly: string }[]
      >`
        SELECT current_database() AS database, current_setting('transaction_read_only') AS readonly,
          current_setting('default_transaction_read_only') AS "defaultReadonly"`;
      if (
        state?.database !== "security_events" ||
        state.readonly !== "on" ||
        state.defaultReadonly !== "on"
      )
        throw new Error("Read-only database target verification failed");
      // Metadata/schema compatibility only; never run migrations.
      await prisma.securityEvent.findFirst({ select: { id: true } });
    },
    disconnect: () => prisma.$disconnect(),
  };
}
