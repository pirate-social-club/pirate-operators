// Embedded audio metadata (ID3) extraction. Artwork parsing is ported from the
// reviewed composer parser; title-frame extraction shares the same bounded
// frame walk. Framework-free byte parsing.

export type EmbeddedArtwork = {
  data: Uint8Array;
  mimeType: string;
};

function readSynchsafeInt(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! << 21) |
    (bytes[offset + 1]! << 14) |
    (bytes[offset + 2]! << 7) |
    bytes[offset + 3]!
  );
}

function readUint24(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! << 16) | (bytes[offset + 1]! << 8) | bytes[offset + 2]!
  );
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) |
      (bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!) >>>
    0
  );
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let value = "";
  for (let index = 0; index < length; index += 1) {
    const code = bytes[start + index]!;
    if (code === 0) break;
    value += String.fromCharCode(code);
  }
  return value;
}

function findSingleNull(bytes: Uint8Array, start: number): number {
  for (let index = start; index < bytes.length; index += 1) {
    if (bytes[index] === 0) return index;
  }
  return -1;
}

function findTextTerminator(
  bytes: Uint8Array,
  start: number,
  encoding: number,
): number {
  if (encoding === 1 || encoding === 2) {
    for (let index = start; index + 1 < bytes.length; index += 2) {
      if (bytes[index] === 0 && bytes[index + 1] === 0) return index;
    }
    return -1;
  }

  return findSingleNull(bytes, start);
}

function extensionForMimeType(mimeType: string): string {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/gif") return "gif";
  return "jpg";
}

function fileBaseName(name: string): string {
  const dotIndex = name.lastIndexOf(".");
  return (dotIndex > 0 ? name.slice(0, dotIndex) : name).trim() || "audio";
}

function parseApicFrame(frame: Uint8Array): EmbeddedArtwork | null {
  if (frame.length < 5) return null;

  const encoding = frame[0]!;
  const mimeEnd = findSingleNull(frame, 1);
  if (mimeEnd === -1 || mimeEnd + 2 >= frame.length) return null;

  const mimeType = ascii(frame, 1, mimeEnd - 1).toLowerCase();
  const descriptionStart = mimeEnd + 2;
  const descriptionEnd = findTextTerminator(frame, descriptionStart, encoding);
  const imageStart =
    descriptionEnd === -1
      ? descriptionStart
      : descriptionEnd + (encoding === 1 || encoding === 2 ? 2 : 1);

  if (imageStart >= frame.length || !mimeType.startsWith("image/")) return null;

  return {
    data: frame.slice(imageStart),
    mimeType,
  };
}

function parsePicFrame(frame: Uint8Array): EmbeddedArtwork | null {
  if (frame.length < 6) return null;

  const encoding = frame[0]!;
  const format = ascii(frame, 1, 3).toUpperCase();
  const mimeType = format === "PNG" ? "image/png" : "image/jpeg";
  const descriptionStart = 5;
  const descriptionEnd = findTextTerminator(frame, descriptionStart, encoding);
  const imageStart =
    descriptionEnd === -1
      ? descriptionStart
      : descriptionEnd + (encoding === 1 || encoding === 2 ? 2 : 1);

  if (imageStart >= frame.length) return null;

  return {
    data: frame.slice(imageStart),
    mimeType,
  };
}

function* iterateId3Frames(bytes: Uint8Array): Generator<{
  frame: Uint8Array;
  id: string;
  majorVersion: number;
}> {
  if (bytes.length < 10 || ascii(bytes, 0, 3) !== "ID3") return;

  const majorVersion = bytes[3]!;
  const tagSize = readSynchsafeInt(bytes, 6);
  const tagEnd = Math.min(bytes.length, 10 + tagSize);
  let offset = 10;

  while (offset < tagEnd) {
    if (majorVersion === 2) {
      if (offset + 6 > tagEnd) return;
      const frameId = ascii(bytes, offset, 3);
      const frameSize = readUint24(bytes, offset + 3);
      offset += 6;
      if (!frameId.trim() || frameSize <= 0 || offset + frameSize > tagEnd)
        return;
      yield {
        frame: bytes.slice(offset, offset + frameSize),
        id: frameId,
        majorVersion,
      };
      offset += frameSize;
      continue;
    }

    if (offset + 10 > tagEnd) return;
    const frameId = ascii(bytes, offset, 4);
    const frameSize =
      majorVersion === 4
        ? readSynchsafeInt(bytes, offset + 4)
        : readUint32(bytes, offset + 4);
    offset += 10;
    if (!frameId.trim() || frameSize <= 0 || offset + frameSize > tagEnd)
      return;
    yield {
      frame: bytes.slice(offset, offset + frameSize),
      id: frameId,
      majorVersion,
    };
    offset += frameSize;
  }
}

export function extractEmbeddedAudioArtworkBytes(
  bytes: Uint8Array,
): EmbeddedArtwork | null {
  for (const { frame, id, majorVersion } of iterateId3Frames(bytes)) {
    if (majorVersion === 2) {
      if (id === "PIC") return parsePicFrame(frame);
      continue;
    }
    if (id === "APIC") return parseApicFrame(frame);
  }

  return null;
}

function decodeLatin1(bytes: Uint8Array): string {
  let value = "";
  for (let index = 0; index < bytes.length; index += 1) {
    const code = bytes[index]!;
    if (code === 0) break;
    value += String.fromCharCode(code);
  }
  return value;
}

function decodeUtf16(bytes: Uint8Array, littleEndian: boolean): string {
  let value = "";
  for (let index = 0; index + 1 < bytes.length; index += 2) {
    const unit = littleEndian
      ? bytes[index]! | (bytes[index + 1]! << 8)
      : (bytes[index]! << 8) | bytes[index + 1]!;
    if (unit === 0) break;
    value += String.fromCharCode(unit);
  }
  return value;
}

function decodeTextFrame(frame: Uint8Array): string | null {
  if (frame.length < 1) return null;
  const encoding = frame[0]!;
  const body = frame.subarray(1);
  if (encoding === 1) {
    const hasBigEndianBom = body[0] === 0xfe && body[1] === 0xff;
    const hasLittleEndianBom = body[0] === 0xff && body[1] === 0xfe;
    return decodeUtf16(
      hasBigEndianBom || hasLittleEndianBom ? body.subarray(2) : body,
      !hasBigEndianBom,
    );
  }
  if (encoding === 2) return decodeUtf16(body, false);
  if (encoding === 3) {
    const decoded = new TextDecoder("utf-8").decode(body);
    const terminator = decoded.indexOf("\u0000");
    return terminator === -1 ? decoded : decoded.slice(0, terminator);
  }
  return decodeLatin1(body);
}

export function extractEmbeddedAudioTitleBytes(
  bytes: Uint8Array,
): string | null {
  for (const { frame, id, majorVersion } of iterateId3Frames(bytes)) {
    if (majorVersion === 2 ? id === "TT2" : id === "TIT2")
      return decodeTextFrame(frame)?.trim() || null;
  }

  return null;
}

export async function extractEmbeddedAudioArtworkFile(
  file: File,
): Promise<File | null> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const artwork = extractEmbeddedAudioArtworkBytes(bytes);

  if (!artwork) return null;

  const extension = extensionForMimeType(artwork.mimeType);
  const imageBuffer = new ArrayBuffer(artwork.data.byteLength);
  new Uint8Array(imageBuffer).set(artwork.data);

  return new File(
    [imageBuffer],
    `${fileBaseName(file.name)}-cover.${extension}`,
    { type: artwork.mimeType },
  );
}

export async function extractEmbeddedAudioTitle(
  file: File,
): Promise<string | null> {
  return extractEmbeddedAudioTitleBytes(
    new Uint8Array(await file.arrayBuffer()),
  );
}
