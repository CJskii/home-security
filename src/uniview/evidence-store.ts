import type { PrismaClient } from '../generated/prisma/client.js';
import type { EvidenceMetadata } from './ingest.js';
export type ProcessingStatus = 'COLLECTING' | 'ANALYSING' | 'COMPLETE' | 'SKIPPED' | 'FAILED' | 'INTERRUPTED';
export interface EvidenceStore {
  interrupt(): Promise<void>;
  claim(eventId: string, startedAt: Date, status: ProcessingStatus, reason: string | null): Promise<boolean>;
  finish(eventId: string, status: ProcessingStatus, reason: string, finishedAt: Date): Promise<void>;
  sample(eventId: string, metadata: EvidenceMetadata): Promise<void>;
}
export function createEvidenceStore(prisma: PrismaClient): EvidenceStore {
  return {
    async interrupt() { await prisma.evidenceProcessing.updateMany({ where: { status: { in: ['COLLECTING', 'ANALYSING'] } }, data: { status: 'INTERRUPTED', reason: 'receiver_restart', finishedAt: new Date() } }); },
    async claim(eventId, startedAt, status, reason) {
      try { await prisma.evidenceProcessing.create({ data: { eventId, startedAt, status, reason, finishedAt: status === 'COLLECTING' ? null : startedAt } }); return true; }
      catch (error) { if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') return false; throw error; }
    },
    async finish(eventId, status, reason, finishedAt) { await prisma.evidenceProcessing.updateMany({ where: { eventId, status: { in: ['COLLECTING', 'ANALYSING'] } }, data: { status, reason, finishedAt } }); },
    async sample(eventId, metadata) { await prisma.eventSnapshot.create({ data: { ...metadata, eventId } }); },
  };
}
