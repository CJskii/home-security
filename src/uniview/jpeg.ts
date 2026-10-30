// Locate the main codestream EOI, skipping embedded thumbnails in APP segments
// and byte-stuffed/restart markers in entropy data. Never decode or re-encode.
export function originalJpeg(bytes: Buffer): Buffer {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('Invalid JPEG');
  let offset = 2, scan = false;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) throw new Error('Invalid JPEG marker');
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9) {
      if (!scan) throw new Error('Missing JPEG scan');
      const result = bytes.subarray(0, offset);
      jpegDimensions(result);
      return result;
    }
    if (marker === undefined || marker === 0 || marker === 0xd8) throw new Error('Invalid JPEG marker');
    if (marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) throw new Error('Truncated JPEG');
    const size = bytes.readUInt16BE(offset);
    if (size < 2 || offset + size > bytes.length) throw new Error('Invalid JPEG length');
    offset += size;
    if (marker === 0xda) {
      scan = true;
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) { offset++; continue; }
        const start = offset++;
        while (bytes[offset] === 0xff) offset++;
        const next = bytes[offset];
        if (next === 0 || (next !== undefined && next >= 0xd0 && next <= 0xd7)) { offset++; continue; }
        offset = start; break;
      }
    }
  }
  throw new Error('Truncated JPEG');
}

export function jpegDimensions(bytes: Buffer) {
  if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) throw new Error('Invalid JPEG');
  let offset = 2; let dimensions: { width: number; height: number } | undefined;
  const frames = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  while (offset < bytes.length - 2) {
    if (bytes[offset] !== 255) break;
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (marker === undefined || offset + 2 > bytes.length) break;
    if (marker === 0xda) {
      const size = bytes.readUInt16BE(offset);
      if (dimensions && size >= 6 && offset + size < bytes.length - 2) return dimensions;
      break;
    }
    if (marker === 0xd8 || marker === 0xd9 || marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const size = bytes.readUInt16BE(offset);
    if (size < 2 || offset + size > bytes.length) break;
    if (frames.has(marker)) {
      if (size < 8) break;
      const height = bytes.readUInt16BE(offset + 3), width = bytes.readUInt16BE(offset + 5);
      if (!width || !height) break;
      dimensions = { width, height };
    }
    offset += size;
  }
  throw new Error('Invalid JPEG headers');
}
