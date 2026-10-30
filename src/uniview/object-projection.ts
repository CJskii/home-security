import type { Prisma } from '../generated/prisma/client.js';
import type { Kind } from './schemas.js';

export type ObjectCategory = 'PERSON' | 'MOTOR_VEHICLE' | 'NON_MOTOR_VEHICLE' | 'UNKNOWN';
export interface ObjectImage {
  id: string; eventId: string; notificationId: string | null; origin: string;
  sourceImageIndex: number | null; imageType: string | null;
}
export interface ObjectSource {
  id: string; eventId: string; kind: Kind; reportedAt: Date | null; metadata: unknown;
}
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const scalar = (value: unknown): string | null => typeof value === 'string' || typeof value === 'number' ? String(value) : null;
const index = (value: unknown): number | null => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;

// Verified Alarm class codes; VehicleAttributeInfo.Type (including 998) is a subtype,
// never an alternative source of classification. Structure list names identify class.
function alarmCategory(code: string | null): ObjectCategory {
  return code === '2' ? 'PERSON' : code === '4' ? 'MOTOR_VEHICLE' : code === '3' ? 'NON_MOTOR_VEHICLE' : 'UNKNOWN';
}
export function projectObjects(source: ObjectSource, images: readonly ObjectImage[]): Prisma.UniviewObjectCreateManyInput[] {
  const metadata = record(source.metadata);
  const objInfo = record(record(metadata.StructureInfo).ObjInfo);
  const lists: [string, unknown, ObjectCategory | null][] = [
    ['RelatedObjects.ObjectList', record(metadata.RelatedObjects).ObjectList, null],
    ['StructureInfo.ObjInfo.PersonInfoList', objInfo.PersonInfoList, 'PERSON'],
    ['StructureInfo.ObjInfo.VehicleInfoList', objInfo.VehicleInfoList, 'MOTOR_VEHICLE'],
    ['StructureInfo.ObjInfo.NonMotorVehicleInfoList', objInfo.NonMotorVehicleInfoList, 'NON_MOTOR_VEHICLE'],
    ['StructureInfo.ObjInfo.ObjectList', objInfo.ObjectList, 'UNKNOWN'],
  ];
  const results: Prisma.UniviewObjectCreateManyInput[] = [];
  for (const [sourceList, entries, listCategory] of lists) {
    if (!Array.isArray(entries)) continue;
    entries.forEach((entry: unknown, sourceOrdinal) => {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return;
      const object = record(entry);
      const sourceCategoryCode = scalar(object.ObjectType);
      const sourceIdentifiers = Object.fromEntries(Object.entries(object).filter(([key, value]) =>
        /ID$/.test(key) && (typeof value === 'string' || typeof value === 'number')));
      const positionRaw = typeof object.Position === 'string' ? object.Position : null;
      const match = positionRaw?.match(/^(\d+),(\d+);(\d+),(\d+)$/);
      const values = match?.slice(1).map(Number);
      const valid = values && values.every((v) => Number.isSafeInteger(v) && v >= 0 && v <= 10000)
        && values[0]! < values[2]! && values[1]! < values[3]!;
      const fullFrameImageIndex = index(object.LargePicAttachIndex);
      const cropImageIndex = index(object.SmallPicAttachIndex);
      const image = (imageIndex: number | null, type: string) => {
        if (imageIndex === null) return null;
        const matches = images.filter((s) => s.eventId === source.eventId && s.notificationId === source.id
          && s.origin === 'NVR_PUSH' && s.sourceImageIndex === imageIndex && s.imageType === type);
        return matches.length === 1 ? matches[0]!.id : null;
      };
      const objectTime = typeof object.TimeStamp === 'number' && Number.isFinite(object.TimeStamp)
        && object.TimeStamp > 0 && object.TimeStamp <= 253402300799 ? new Date(Math.round(object.TimeStamp * 1000)) : null;
      results.push({ eventId: source.eventId, notificationId: source.id, sourceList, sourceOrdinal,
        sourceIdentifiers: sourceIdentifiers as Prisma.InputJsonObject, sourceCategoryCode,
        sourceSubtypeCode: scalar(record(object.VehicleAttributeInfo).Type),
        category: listCategory ?? alarmCategory(sourceCategoryCode),
        classificationBasis: listCategory === null ? 'ALARM_OBJECT_TYPE' : 'STRUCTURE_LIST',
        positionRaw, coordinateStatus: object.Position === undefined || object.Position === null ? 'MISSING' : valid ? 'VALID' : 'INVALID',
        xMin: valid ? values[0]! : null, yMin: valid ? values[1]! : null,
        xMax: valid ? values[2]! : null, yMax: valid ? values[3]! : null,
        sourceTimestamp: objectTime ?? source.reportedAt, timestampBasis: objectTime ? 'OBJECT_TIMESTAMP' : 'NOTIFICATION_REPORTED_AT',
        fullFrameImageIndex, cropImageIndex,
        fullFrameSnapshotId: image(fullFrameImageIndex, '1'), cropSnapshotId: image(cropImageIndex, '2'),
        projectionVersion: 1,
      });
    });
  }
  return results;
}
