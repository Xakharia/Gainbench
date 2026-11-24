import type { Id3ArtworkInfo, Id3LyricsInfo, ParsedId3Metadata } from '../types/audio';

function readSynchsafeInt(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] & 0x7f) << 21) |
    ((bytes[offset + 1] & 0x7f) << 14) |
    ((bytes[offset + 2] & 0x7f) << 7) |
    (bytes[offset + 3] & 0x7f)
  );
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

function readUint24BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2];
}

function removeUnsynchronization(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  let j = 0;
  for (let i = 0; i < data.length; i++) {
    out[j++] = data[i];
    if (data[i] === 0xff && i + 1 < data.length && data[i + 1] === 0x00) {
      i++;
    }
  }
  return out.subarray(0, j);
}

function decodeText(bytes: Uint8Array, encoding: number): string {
  if (bytes.length === 0) return '';
  try {
    if (encoding === 0) {
      // ISO-8859-1
      return new TextDecoder('iso-8859-1').decode(bytes).replace(/\0+$/, '');
    }
    if (encoding === 1) {
      // UTF-16 with BOM
      if (bytes.length >= 2) {
        if (bytes[0] === 0xff && bytes[1] === 0xfe) {
          return new TextDecoder('utf-16le').decode(bytes.subarray(2)).replace(/\0+$/, '');
        }
        if (bytes[0] === 0xfe && bytes[1] === 0xff) {
          return new TextDecoder('utf-16be').decode(bytes.subarray(2)).replace(/\0+$/, '');
        }
      }
      return new TextDecoder('utf-16le').decode(bytes).replace(/\0+$/, '');
    }
    if (encoding === 2) {
      // UTF-16BE without BOM
      return new TextDecoder('utf-16be').decode(bytes).replace(/\0+$/, '');
    }
    if (encoding === 3) {
      // UTF-8
      return new TextDecoder('utf-8').decode(bytes).replace(/\0+$/, '');
    }
  } catch {
    // Fallback
  }
  return new TextDecoder('latin1').decode(bytes).replace(/\0+$/, '');
}

function findNullTerminator(bytes: Uint8Array, start: number, encoding: number): number {
  const isDoubleByte = encoding === 1 || encoding === 2;
  if (!isDoubleByte) {
    for (let i = start; i < bytes.length; i++) {
      if (bytes[i] === 0) return i;
    }
    return bytes.length;
  }
  for (let i = start; i + 1 < bytes.length; i += 2) {
    if (bytes[i] === 0 && bytes[i + 1] === 0) return i;
  }
  return bytes.length;
}

function readAscii(bytes: Uint8Array, start: number, length: number): string {
  let s = '';
  for (let i = 0; i < length && start + i < bytes.length; i++) {
    s += String.fromCharCode(bytes[start + i]);
  }
  return s;
}

function isValidMpegHeaderAt(bytes: Uint8Array, offset: number): boolean {
  if (offset + 4 > bytes.length) return false;
  const b0 = bytes[offset];
  const b1 = bytes[offset + 1];
  const b2 = bytes[offset + 2];
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return false;
  const version = (b1 >> 3) & 0x03;
  const layer = (b1 >> 1) & 0x03;
  const bitrateIdx = (b2 >> 4) & 0x0f;
  const sampleRateIdx = (b2 >> 2) & 0x03;
  if (version === 1 || layer === 0) return false;
  if (bitrateIdx === 0 || bitrateIdx === 15) return false;
  if (sampleRateIdx === 3) return false;
  return true;
}

function parseApicFrame(payload: Uint8Array, isV22: boolean): Id3ArtworkInfo | null {
  if (payload.length < 4) return null;
  const encoding = payload[0];
  let offset = 1;
  let mimeType = 'image/jpeg';

  if (isV22) {
    const fmt = readAscii(payload, offset, 3).toUpperCase();
    offset += 3;
    mimeType = fmt === 'PNG' ? 'image/png' : fmt === 'GIF' ? 'image/gif' : 'image/jpeg';
  } else {
    const mimeEnd = findNullTerminator(payload, offset, 0);
    mimeType = readAscii(payload, offset, mimeEnd - offset).trim() || 'image/jpeg';
    offset = mimeEnd + 1;
  }

  if (offset >= payload.length) return null;
  const pictureType = payload[offset];
  offset += 1;

  const descEnd = findNullTerminator(payload, offset, encoding);
  const description = decodeText(payload.subarray(offset, descEnd), encoding);
  const terminatorLen = encoding === 1 || encoding === 2 ? 2 : 1;
  const imageStart = Math.min(payload.length, descEnd + terminatorLen);
  const imageBytes = payload.subarray(imageStart);

  if (imageBytes.length < 16) return null;

  // Sniff magic header if MIME is generic or empty
  if (mimeType === 'image/' || mimeType === '-->' || !mimeType.includes('/')) {
    if (imageBytes[0] === 0x89 && imageBytes[1] === 0x50) mimeType = 'image/png';
    else if (imageBytes[0] === 0xff && imageBytes[1] === 0xd8) mimeType = 'image/jpeg';
    else mimeType = 'image/jpeg';
  }

  const blob = new Blob([new Uint8Array(imageBytes)], { type: mimeType });
  const objectUrl = URL.createObjectURL(blob);

  return {
    mimeType,
    description,
    pictureType,
    byteLength: imageBytes.length,
    objectUrl,
  };
}

function parseUsltFrame(payload: Uint8Array): Id3LyricsInfo | null {
  if (payload.length < 5) return null;
  const encoding = payload[0];
  const language = readAscii(payload, 1, 3).replace(/\0/g, '') || 'eng';
  let offset = 4;
  const descEnd = findNullTerminator(payload, offset, encoding);
  const description = decodeText(payload.subarray(offset, descEnd), encoding);
  const terminatorLen = encoding === 1 || encoding === 2 ? 2 : 1;
  const textStart = Math.min(payload.length, descEnd + terminatorLen);
  const text = decodeText(payload.subarray(textStart), encoding).trim();

  if (!text) return null;
  return {
    language,
    description,
    text,
    isSynchronized: false,
    byteLength: payload.length,
  };
}

function parseSyltFrame(payload: Uint8Array): Id3LyricsInfo | null {
  if (payload.length < 7) return null;
  const encoding = payload[0];
  const language = readAscii(payload, 1, 3).replace(/\0/g, '') || 'eng';
  // payload[4] = time stamp format, payload[5] = content type
  let offset = 6;
  const descEnd = findNullTerminator(payload, offset, encoding);
  const description = decodeText(payload.subarray(offset, descEnd), encoding);
  const terminatorLen = encoding === 1 || encoding === 2 ? 2 : 1;
  offset = Math.min(payload.length, descEnd + terminatorLen);

  const lines: string[] = [];
  while (offset < payload.length) {
    const lineEnd = findNullTerminator(payload, offset, encoding);
    const segment = decodeText(payload.subarray(offset, lineEnd), encoding);
    if (segment) lines.push(segment);
    offset = lineEnd + terminatorLen + 4; // skip 4-byte timestamp
  }
  const text = lines.join('\n').trim();
  if (!text) return null;
  return {
    language,
    description,
    text,
    isSynchronized: true,
    byteLength: payload.length,
  };
}

function detectTailMetadataOffset(bytes: Uint8Array, minStart: number): {
  audioEndOffset: number;
  hasId3v1: boolean;
  hasApeOrLyricsTail: boolean;
} {
  let end = bytes.length;
  let hasId3v1 = false;
  let hasApeOrLyricsTail = false;

  // Check ID3v1 (last 128 bytes starting with "TAG")
  if (end - 128 >= minStart) {
    if (bytes[end - 128] === 0x54 && bytes[end - 127] === 0x41 && bytes[end - 126] === 0x47) {
      hasId3v1 = true;
      end -= 128;
    }
  }

  // Check APEv2 footer right before ID3v1 (or at EOF): "APETAGEX" (32 bytes footer)
  if (end - 32 >= minStart) {
    const sig = readAscii(bytes, end - 32, 8);
    if (sig === 'APETAGEX') {
      const apeSize =
        bytes[end - 20] |
        (bytes[end - 19] << 8) |
        (bytes[end - 18] << 16) |
        (bytes[end - 17] << 24);
      const flags =
        bytes[end - 12] |
        (bytes[end - 11] << 8) |
        (bytes[end - 10] << 16) |
        (bytes[end - 9] << 24);
      const hasHeader = (flags & 0x80000000) !== 0;
      const totalApeBytes = apeSize + (hasHeader ? 32 : 0);
      if (totalApeBytes >= 32 && end - totalApeBytes >= minStart) {
        hasApeOrLyricsTail = true;
        end -= totalApeBytes;
      }
    }
  }

  // Check Lyrics3v2 ("LYRICS200" right before ID3v1)
  if (end - 15 >= minStart && readAscii(bytes, end - 9, 9) === 'LYRICS200') {
    const sizeStr = readAscii(bytes, end - 15, 6);
    const lyrSize = parseInt(sizeStr, 10);
    if (!Number.isNaN(lyrSize) && lyrSize > 0 && end - 15 - lyrSize >= minStart) {
      hasApeOrLyricsTail = true;
      end -= 15 + lyrSize;
    }
  }

  return {
    audioEndOffset: end,
    hasId3v1,
    hasApeOrLyricsTail,
  };
}

export function parseId3AndMetadata(bytes: Uint8Array, fallbackName: string): ParsedId3Metadata {
  let hasId3v2 = false;
  let id3v2Version: string | null = null;
  let id3v2End = 0;

  let title = '';
  let artist = '';
  let album = '';
  let year = '';
  const frameIds: string[] = [];
  let artwork: Id3ArtworkInfo | null = null;
  let lyrics: Id3LyricsInfo | null = null;

  // Check for ID3v2 header at byte 0
  if (
    bytes.length >= 10 &&
    bytes[0] === 0x49 && // 'I'
    bytes[1] === 0x44 && // 'D'
    bytes[2] === 0x33 && // '3'
    bytes[3] >= 2 &&
    bytes[3] <= 4
  ) {
    hasId3v2 = true;
    const major = bytes[3];
    const minor = bytes[4];
    id3v2Version = `ID3v2.${major}.${minor}`;
    const flags = bytes[5];
    const tagSize = readSynchsafeInt(bytes, 6);
    const hasFooter = major === 4 && (flags & 0x10) !== 0;
    id3v2End = Math.min(bytes.length, 10 + tagSize + (hasFooter ? 10 : 0));

    let tagBody = bytes.subarray(10, Math.min(bytes.length, 10 + tagSize));
    const globalUnsync = (flags & 0x80) !== 0;
    if (globalUnsync && major <= 3) {
      tagBody = removeUnsynchronization(tagBody);
    }

    let offset = 0;
    // Skip extended header if present
    if ((flags & 0x40) !== 0 && tagBody.length >= 4) {
      if (major === 3) {
        const extSize = readUint32BE(tagBody, 0);
        offset += 4 + extSize;
      } else if (major === 4) {
        const extSize = readSynchsafeInt(tagBody, 0);
        offset += extSize;
      }
    }

    while (offset < tagBody.length) {
      if (tagBody[offset] === 0) break; // Padding reached

      if (major === 2) {
        if (offset + 6 > tagBody.length) break;
        const frameId = readAscii(tagBody, offset, 3);
        const frameSize = readUint24BE(tagBody, offset + 3);
        offset += 6;
        if (frameSize <= 0 || offset + frameSize > tagBody.length) break;
        const payload = tagBody.subarray(offset, offset + frameSize);
        offset += frameSize;

        frameIds.push(frameId);
        if (frameId === 'TT2' && payload.length > 1) title = decodeText(payload.subarray(1), payload[0]);
        else if (frameId === 'TP1' && payload.length > 1) artist = decodeText(payload.subarray(1), payload[0]);
        else if (frameId === 'TAL' && payload.length > 1) album = decodeText(payload.subarray(1), payload[0]);
        else if (frameId === 'TYE' && payload.length > 1) year = decodeText(payload.subarray(1), payload[0]);
        else if (frameId === 'PIC' && !artwork) artwork = parseApicFrame(payload, true);
        else if (frameId === 'ULT' && !lyrics) lyrics = parseUsltFrame(payload);
      } else {
        if (offset + 10 > tagBody.length) break;
        const frameId = readAscii(tagBody, offset, 4);
        if (!/^[A-Z0-9]{4}$/.test(frameId)) break;
        const frameSize =
          major === 4 ? readSynchsafeInt(tagBody, offset + 4) : readUint32BE(tagBody, offset + 4);
        const frameFlags = (tagBody[offset + 8] << 8) | tagBody[offset + 9];
        offset += 10;
        if (frameSize <= 0 || offset + frameSize > tagBody.length) break;

        let payload = tagBody.subarray(offset, offset + frameSize);
        offset += frameSize;

        // Handle ID3v2.4 frame-level unsynchronization / data length indicator
        if (major === 4) {
          const hasDataLen = (frameFlags & 0x0001) !== 0;
          const hasUnsync = (frameFlags & 0x0002) !== 0;
          if (hasDataLen && payload.length >= 4) {
            payload = payload.subarray(4);
          }
          if (hasUnsync || globalUnsync) {
            payload = removeUnsynchronization(payload);
          }
        }

        frameIds.push(frameId);
        if (frameId === 'TIT2' && payload.length > 1) title = decodeText(payload.subarray(1), payload[0]);
        else if (frameId === 'TPE1' && payload.length > 1) artist = decodeText(payload.subarray(1), payload[0]);
        else if (frameId === 'TALB' && payload.length > 1) album = decodeText(payload.subarray(1), payload[0]);
        else if ((frameId === 'TYER' || frameId === 'TDRC') && payload.length > 1 && !year) {
          year = decodeText(payload.subarray(1), payload[0]).slice(0, 4);
        } else if (frameId === 'APIC') {
          const parsedArt = parseApicFrame(payload, false);
          // Prefer front cover (type 3) if multiple APIC frames exist
          if (parsedArt && (!artwork || parsedArt.pictureType === 3)) {
            if (artwork) URL.revokeObjectURL(artwork.objectUrl);
            artwork = parsedArt;
          } else if (parsedArt) {
            URL.revokeObjectURL(parsedArt.objectUrl);
          }
        } else if (frameId === 'USLT' && !lyrics) {
          lyrics = parseUsltFrame(payload);
        } else if (frameId === 'SYLT' && !lyrics) {
          lyrics = parseSyltFrame(payload);
        }
      }
    }
  }

  // Advance audioStartOffset past any junk/zero padding to the first real MPEG sync frame
  let audioStartOffset = id3v2End;
  if (hasId3v2) {
    const searchLimit = Math.min(bytes.length, id3v2End + 4096);
    for (let i = id3v2End; i < searchLimit; i++) {
      if (isValidMpegHeaderAt(bytes, i)) {
        audioStartOffset = i;
        break;
      }
    }
  }

  const tail = detectTailMetadataOffset(bytes, audioStartOffset);

  // Fallback to ID3v1 fields if ID3v2 didn't supply them
  if (tail.hasId3v1) {
    const v1Offset = bytes.length - 128;
    if (!title) title = new TextDecoder('iso-8859-1').decode(bytes.subarray(v1Offset + 3, v1Offset + 33)).replace(/\0+$/, '').trim();
    if (!artist) artist = new TextDecoder('iso-8859-1').decode(bytes.subarray(v1Offset + 33, v1Offset + 63)).replace(/\0+$/, '').trim();
    if (!album) album = new TextDecoder('iso-8859-1').decode(bytes.subarray(v1Offset + 63, v1Offset + 93)).replace(/\0+$/, '').trim();
    if (!year) year = new TextDecoder('iso-8859-1').decode(bytes.subarray(v1Offset + 93, v1Offset + 97)).replace(/\0+$/, '').trim();
  }

  const cleanBaseName = fallbackName.replace(/\.[^/.]+$/, '');

  return {
    hasId3v2,
    id3v2Version,
    id3v2ByteLength: audioStartOffset,
    hasId3v1: tail.hasId3v1,
    hasApeOrLyricsTail: tail.hasApeOrLyricsTail,
    tailByteLength: bytes.length - tail.audioEndOffset,
    audioStartOffset,
    audioEndOffset: tail.audioEndOffset,
    title: title || cleanBaseName,
    artist,
    album,
    year,
    frameIds,
    artwork,
    lyrics,
    rawHeaderBytes: bytes.slice(0, audioStartOffset),
    rawTailBytes: bytes.slice(tail.audioEndOffset),
  };
}
