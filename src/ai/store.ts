import type { PrismaClient, Prisma } from '../generated/prisma/client.js';
import type { AnalysisResult } from './schemas.js';
export interface AnalysisSource { confirmed: boolean; firstReceivedAt: Date; facts: Record<string, unknown> }
export interface AnalysisWrite {
  eventId: string; inputFingerprint: string; model: string; promptVersion: number; schemaVersion: number;
  result: AnalysisResult; evidence: Record<string, unknown>[]; completedAt: Date;
}
export interface AnalysisStore {
  source(eventId: string): Promise<AnalysisSource | null>;
  begin(eventId: string, reprocess?: boolean, startedAt?: Date): Promise<boolean>;
  retry(eventId:string):Promise<void>;
  save(write: AnalysisWrite): Promise<boolean>;
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function scalar(value: unknown) { return typeof value === 'number' && Number.isFinite(value) || typeof value === 'string' && value.length <= 256 ? value : null; }
export function createAnalysisStore(prisma: PrismaClient): AnalysisStore {
  return {
    async source(eventId) {
      const e = await prisma.securityEvent.findUnique({ where: { id: eventId }, select: { firstReceivedAt: true, alarmSeen: true, alarmType: true,
        notifications: { select: { kind: true, metadata: true, reportedAt: true, personCount: true, vehicleCount: true }, orderBy: { receivedAt: 'desc' }, take: 16 },
        objects: {where:{OR:[{fullFrameSnapshotId:{not:null}},{cropSnapshotId:{not:null}}]},take:5,orderBy:{id:'asc'},select:{id:true,category:true,coordinateStatus:true,xMin:true,yMin:true,xMax:true,yMax:true,
          fullFrameSnapshot:{select:{sha256:true}},cropSnapshot:{select:{sha256:true}}}},
        snapshots: { select: { origin: true, status: true, failureCode: true, imageOrdinal: true }, take: 16 } } });
      if (!e) return null;
      const alarm = e.notifications.find((n) => n.kind === 'ALARM'), structure = e.notifications.find((n) => n.kind === 'STRUCTURE');
      const related = object(object(alarm?.metadata).RelatedObjects), info = object(object(object(structure?.metadata).StructureInfo).ObjInfo);
      const objects = Array.isArray(related.ObjectList) ? related.ObjectList.slice(0, 4).map((o: unknown) => ({ id: scalar(object(o).ObjectID), typeCode: scalar(object(o).ObjectType) })) : [];
      const positions = Array.isArray(info.PersonInfoList) ? info.PersonInfoList.slice(0, 4).map((p: unknown) => ({ sourcePersonId: scalar(object(p).PersonID), rawPosition: scalar(object(p).Position) })) : [];
      const targets=e.objects.slice(0,4).map(o=>({objectId:o.id,category:o.category.toLowerCase(),fullFrameSha256:o.fullFrameSnapshot?.sha256??null,cropSha256:o.cropSnapshot?.sha256??null,
        rectangle:o.coordinateStatus==='VALID'?{xMin:o.xMin,yMin:o.yMin,xMax:o.xMax,yMax:o.yMax,scale:10000}:null}));
      return { confirmed: e.alarmSeen || e.objects.length>0, firstReceivedAt: e.firstReceivedAt, facts: {
        targets,targetsTruncated:e.objects.length>4,alarmType: e.alarmType, sourceTimestamp: alarm?.reportedAt?.toISOString() ?? structure?.reportedAt?.toISOString() ?? null,
        persons: structure?.personCount ?? null, vehicles: structure?.vehicleCount ?? null,
        nonMotorVehicles: scalar(info.NonMotorVehicleNum), faces: scalar(info.FaceNum), sourceObjects: objects, sourcePositions: positions,
        failedAcquisitions: e.snapshots.filter((s) => s.status === 'FAILED').slice(0, 4).map((s) => ({ origin: s.origin, ordinal: s.imageOrdinal, reason: s.failureCode })),
      } };
    },
    async begin(eventId,reprocess=false,startedAt=new Date()) {
      const changed = await prisma.evidenceProcessing.updateMany({ where: { eventId, status: reprocess ? {in:['COMPLETE','FAILED','SKIPPED','INTERRUPTED']} : 'COLLECTING', ...(reprocess?{}:{event: { analysis: null }}) }, data: { status: 'ANALYSING', reason: null,finishedAt:null,analysisStartedAt:startedAt,analysisRetries:0,analysisAttempts:{increment:1} } });
      return changed.count === 1;
    },
    async retry(eventId) {await prisma.evidenceProcessing.updateMany({where:{eventId,status:'ANALYSING'},data:{analysisRetries:{increment:1}}});},
    save: (write) => prisma.$transaction(async (tx) => {
      const changed = await tx.evidenceProcessing.updateMany({ where: { eventId: write.eventId, status: 'ANALYSING' }, data: { status: 'COMPLETE', reason: 'ai_complete', finishedAt: write.completedAt } });
      if (changed.count !== 1) return false;
      const r = write.result;
      const data = { eventId: write.eventId, inputFingerprint: write.inputFingerprint, model: write.model,
        promptVersion: write.promptVersion, schemaVersion: write.schemaVersion, completedAt: write.completedAt,
        activityLabel: r.activityLabel, shortDescription: r.shortDescription,
        subjects: r.subjects as Prisma.InputJsonArray,
        uncertainties: r.uncertainties, evidence: write.evidence as Prisma.InputJsonArray };
      const {eventId:existingEventId,...update}=data;
      await tx.eventAnalysis.upsert({where:{eventId:existingEventId},create:data,update:{...update,revision:{increment:1}}});
      // Composite object FK also fences same-event ownership at the database boundary.
      await tx.objectAnalysis.deleteMany({where:{eventId:write.eventId}});
      if(r.objects.length)await tx.objectAnalysis.createMany({data:r.objects.map(o=>({...o,eventId:write.eventId,actions:o.actions,evidenceImages:o.evidenceImages,uncertainties:o.uncertainties}))});
      return true;
    }, { timeout: 5000 }),
  };
}
