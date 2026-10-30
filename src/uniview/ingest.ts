import { createHash } from 'node:crypto';
import type { Config } from '../config.js';
import { jpegDimensions } from './jpeg.js';
import { normalizeNotification, type Kind, type Notification } from './schemas.js';
export interface EvidenceMetadata {
  imageOrdinal: number; sourceImageIndex: number | null; imageType: string | null;
  declaredWidth: number | null; declaredHeight: number | null; capturedAt: Date | null;
  origin: 'NVR_PUSH' | 'NVR_LIVE' | 'NVR_RECORDING';
  replayRequestedAt?: Date; sha256: string | null; bytes: number | null;
  width: number | null; height: number | null; status: 'RECEIVED' | 'FAILED';
  requestedAt: Date | null; acquiredAt: Date | null; failureCode: string | null;
}
export interface MemoryFrame { bytes: Buffer; metadata: EvidenceMetadata }
export interface IngestionWrite {
  notification: Notification; sourceInstallationId: string; camera: string | null; receivedAt: Date; snapshots: EvidenceMetadata[];
}
export interface UniviewStore { commit(data: IngestionWrite): Promise<{ eventId: string; newNotification: boolean }> }
export class InvalidNotification extends Error { constructor() { super('Invalid notification'); } }
export function inspectFrame(bytes: Buffer, metadata: EvidenceMetadata, config: Config): MemoryFrame {
  if (!bytes.length || bytes.length > config.UNIVIEW_MAX_IMAGE_BYTES) throw new Error('Image limit');
  const dimensions = jpegDimensions(bytes);
  if (dimensions.width * dimensions.height > config.UNIVIEW_MAX_PIXELS) throw new Error('Pixel limit');
  return { bytes, metadata: { ...metadata, ...dimensions, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), status: 'RECEIVED', failureCode: null } };
}
export async function ingestNotification(config: Config, store: UniviewStore, raw: unknown, kind: Kind, now = new Date()) {
  let notification: Notification;
  try { notification = normalizeNotification(raw, kind); } catch { throw new InvalidNotification(); }
  if (notification.images.length > config.UNIVIEW_MAX_IMAGES) throw new InvalidNotification();
  if (!config.UNIVIEW_INSTALLATION_ID) throw new Error('Receiver identity missing');
  const snapshots: EvidenceMetadata[] = [], frames: MemoryFrame[] = [];
  let total = 0;
  for (const [imageOrdinal, image] of notification.images.entries()) {
    let metadata: EvidenceMetadata = { imageOrdinal, sourceImageIndex: image.Index ?? null,
      imageType: image.Type === undefined ? null : String(image.Type),
      declaredWidth: image.Width ?? null, declaredHeight: image.Height ?? null,
      capturedAt: image.CaptureTime === undefined ? null : new Date(Math.round(image.CaptureTime * 1000)),
      origin: 'NVR_PUSH', sha256: null, bytes: null, width: null, height: null,
      status: 'FAILED', requestedAt: null, acquiredAt: now, failureCode: image.Data === undefined ? 'image_unavailable' : 'invalid_image' };
    if (image.Data !== undefined) {
      try {
        if (typeof image.Data !== 'string' || image.Data.length > Math.ceil(config.UNIVIEW_MAX_IMAGE_BYTES / 3) * 4 || image.Data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.Data)) throw new Error('Base64');
        const bytes = Buffer.from(image.Data, 'base64');
        if (bytes.toString('base64') !== image.Data) throw new Error('Base64');
        total += bytes.length; if (total > config.UNIVIEW_MAX_BODY_BYTES) throw new Error('Aggregate limit');
        const frame = inspectFrame(bytes, metadata, config); metadata = frame.metadata; frames.push(frame);
      } catch { /* Invalid images never prevent valid event metadata capture. */ }
    }
    snapshots.push(metadata);
  }
  notification.images = [];
  const data: IngestionWrite = { notification, sourceInstallationId: config.UNIVIEW_INSTALLATION_ID,
    camera: config.UNIVIEW_CAMERA_MAP[String(notification.nvrChannel)] ?? null, receivedAt: now, snapshots };
  for (let attempt = 0; ; attempt++) {
    try { const result = await store.commit(data); return { ...result, frames, nvrChannel: notification.nvrChannel, receivedAt: now }; }
    catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
      if (attempt >= 3 || !['P2002', 'P2034'].includes(String(code))) throw error;
    }
  }
}
