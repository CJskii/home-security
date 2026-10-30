import { createZoneActivity, type ActivityZone } from './dashboard/zone-activity.js';
import { notificationMedia } from './notifications/media.js';
import { createDeliveryStore,type DeliveryStore } from './notifications/destination.js';
import {approvedDestinations} from './notifications/destination-contract.js';
import { createNotificationStore, type NotificationStore } from './notifications/store.js';
import { createZoneEligibilityStore, type ZoneEligibilityStore } from './ai/zone-eligibility-store.js';
import { createProcessingProposalStore, type ProcessingProposalStore } from './ai/processing-proposal.js';
import { createZonePreferenceStore, type ZonePreferenceStore } from './uniview/zone-preferences.js';
import { createCameraConfigurationStore, type CameraConfigurationStore } from './uniview/camera-configuration.js';
import { createStatistics, type StatisticsQuery, type Statistics } from './dashboard/statistics.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';
import type { Config } from './config.js';
import { createEventQueries } from './events/store.js';
import { createUniviewStore, projectStoredEvent } from './uniview/store.js';
import type { UniviewStore } from './uniview/ingest.js';
import { type HistoryQuery } from './events/queries.js';
import { createEvidenceStore, type EvidenceStore } from './uniview/evidence-store.js';
import { createAnalysisStore, type AnalysisStore } from './ai/store.js';
import { createZoneStore, createZoneEnrichmentStore, type ZoneStore } from './uniview/zone-store.js';
import type { ZoneEnrichmentStore } from './uniview/zone-enrichment.js';
import { createHistoricalImageStore } from './uniview/historical-image-store.js';
import type { HistoricalImageStore } from './uniview/historical-image-resolution.js';
export interface EventQueries {
  history(query: HistoryQuery): Promise<Record<string, unknown>[]>;
  get(id: string): Promise<Record<string, unknown> | null>;
  notifications(id: string, limit: number, before?: { receivedAt: Date; id: string }): Promise<Record<string, unknown>[]>;
  snapshots(id: string, limit: number, after?: string): Promise<Record<string, unknown>[]>;
}
export interface Database {
  zoneActivity?: (installation:string, now?:Date)=>Promise<ActivityZone[]>;
  notificationDelivery?:DeliveryStore;
  notifications?:NotificationStore;
  zoneEligibility?:ZoneEligibilityStore;
  processingProposal?:ProcessingProposalStore;
  zonePreferences?: ZonePreferenceStore;
  cameraConfiguration?: CameraConfigurationStore;
  statistics?: (query: StatisticsQuery) => Promise<Statistics>;
  projectObjects?: (eventId: string, installationId: string, signal?: AbortSignal) => Promise<{notifications:number;inserted:number}|null>;
  zones?: ZoneStore;
  zoneEnrichment?: ZoneEnrichmentStore;
  historicalImages?: HistoricalImageStore;
  analysis?: AnalysisStore;
  evidence?: EvidenceStore; uniview?: UniviewStore; events?: EventQueries;
  checkReady(): Promise<void>; disconnect(): Promise<void>;
}
export function createDatabase(config: Config): Database {
  const adapter = new PrismaPg({ connectionString: config.DATABASE_URL, max: config.DB_POOL_MAX,
    connectionTimeoutMillis: config.DB_CHECK_TIMEOUT_MS, query_timeout: config.DB_CHECK_TIMEOUT_MS,
    statement_timeout: config.DB_CHECK_TIMEOUT_MS, idleTimeoutMillis: 10000, application_name: config.SERVICE_NAME });
  const prisma = new PrismaClient({ adapter, log: [] });
  return { zoneActivity:createZoneActivity(prisma), notificationDelivery:createDeliveryStore(prisma,{media:notificationMedia(config),key:config.NOTIFICATION_CREDENTIAL_KEY,approved:approvedDestinations(config.NOTIFICATION_APPROVED_DESTINATIONS),dashboardOrigin:config.NOTIFICATION_DASHBOARD_ORIGIN??config.DASHBOARD_ORIGIN??'http://localhost:5173',forbiddenSecrets:[config.EVENTS_TOKEN,config.DASHBOARD_PASSWORD,config.DASHBOARD_SESSION_KEY,config.UNIVIEW_PASSWORD].filter((v):v is string=>!!v)}), notifications:createNotificationStore(prisma,config), zoneEligibility:createZoneEligibilityStore(prisma), processingProposal:createProcessingProposalStore(prisma), zonePreferences:createZonePreferenceStore(prisma), cameraConfiguration:createCameraConfigurationStore(prisma), statistics: createStatistics(prisma), projectObjects: (id,installation,signal) => projectStoredEvent(prisma,id,installation,signal), zones: createZoneStore(prisma), zoneEnrichment: createZoneEnrichmentStore(prisma), historicalImages: createHistoricalImageStore(prisma), analysis: createAnalysisStore(prisma), evidence: createEvidenceStore(prisma), uniview: createUniviewStore(prisma, config), events: createEventQueries(prisma),
  async checkReady() { await prisma.$queryRaw`SELECT (SELECT count(*) FROM "SecurityEvent" WHERE false), (SELECT count(*) FROM "UniviewNotification" WHERE false), (SELECT count(*) FROM "EventSnapshot" WHERE false), (SELECT count(*) FROM "EvidenceProcessing" WHERE false), (SELECT count(*) FROM "EventAnalysis" WHERE false), (SELECT count(*) FROM "ObjectAnalysis" WHERE false), (SELECT count(*) FROM "UniviewObject" WHERE false), (SELECT count(*) FROM "UniviewZone" WHERE false), (SELECT count(*) FROM "UniviewZoneVersion" WHERE false), (SELECT count(*) FROM "ObjectZoneEvidence" WHERE false), (SELECT count(*) FROM "ObjectZoneMembership" WHERE false), (SELECT count(*) FROM "CameraConfiguration" WHERE false), (SELECT count(configuration) FROM "UniviewZoneVersion" WHERE false), (SELECT count(*) FROM "ZonePreference" WHERE false)`; },
  disconnect: () => prisma.$disconnect() };
}
