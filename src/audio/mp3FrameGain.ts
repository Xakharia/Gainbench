export interface Mp3StreamScanResult {
  frameCount: number;
  detectedBitrateKbps: number | null;
  isVbr: boolean;
  hasCrc: boolean;
  mpegVersion: number; // 1 or 2 (incl. 2.5)
  sampleRate: number;
}

const BITRATE_TABLE_V1_L3 = [
  0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0,
];
const BITRATE_TABLE_V2_L3 = [
  0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0,
];

const SAMPLE_RATE_TABLE: Record<number, number[]> = {
  3: [44100, 48000, 32000, 0], // MPEG 1
  2: [22050, 24000, 16000, 0], // MPEG 2
  0: [11025, 12000, 8000, 0],  // MPEG 2.5
};

interface ParsedFrameHeader {
  offset: number;
  frameSize: number;
  versionBits: number; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
  layerBits: number;   // 1 = Layer III
  hasCrc: boolean;
  bitrateKbps: number;
  sampleRate: number;
  channels: number;
  sideInfoBytes: number;
}

function parseFrameHeader(bytes: Uint8Array, offset: number): ParsedFrameHeader | null {
  if (offset + 4 > bytes.length) return null;
  const b0 = bytes[offset];
  const b1 = bytes[offset + 1];
  const b2 = bytes[offset + 2];
  const b3 = bytes[offset + 3];

  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return null;

  const versionBits = (b1 >> 3) & 0x03;
  const layerBits = (b1 >> 1) & 0x03;
  const protectionBit = b1 & 0x01;
  const bitrateIdx = (b2 >> 4) & 0x0f;
  const sampleRateIdx = (b2 >> 2) & 0x03;
  const paddingBit = (b2 >> 1) & 0x01;
  const channelMode = (b3 >> 6) & 0x03;

  if (versionBits === 1 || layerBits !== 1) return null; // Layer III only
  if (bitrateIdx === 0 || bitrateIdx === 15 || sampleRateIdx === 3) return null;

  const bitrateKbps =
    versionBits === 3 ? BITRATE_TABLE_V1_L3[bitrateIdx] : BITRATE_TABLE_V2_L3[bitrateIdx];
  const sampleRate = SAMPLE_RATE_TABLE[versionBits]?.[sampleRateIdx] ?? 0;
  if (!bitrateKbps || !sampleRate) return null;

  const coeff = versionBits === 3 ? 144 : 72;
  const frameSize = Math.floor((coeff * bitrateKbps * 1000) / sampleRate) + paddingBit;
  if (frameSize < 16 || offset + frameSize > bytes.length) return null;

  const channels = channelMode === 3 ? 1 : 2;
  const sideInfoBytes =
    versionBits === 3 ? (channels === 1 ? 17 : 32) : channels === 1 ? 9 : 17;

  return {
    offset,
    frameSize,
    versionBits,
    layerBits,
    hasCrc: protectionBit === 0,
    bitrateKbps,
    sampleRate,
    channels,
    sideInfoBytes,
  };
}

function isXingOrVbriFrame(bytes: Uint8Array, frame: ParsedFrameHeader): boolean {
  const xingOffset = frame.offset + 4 + (frame.hasCrc ? 2 : 0) + frame.sideInfoBytes;
  if (xingOffset + 4 <= frame.offset + frame.frameSize) {
    const tag = String.fromCharCode(
      bytes[xingOffset],
      bytes[xingOffset + 1],
      bytes[xingOffset + 2],
      bytes[xingOffset + 3]
    );
    if (tag === 'Xing' || tag === 'Info') return true;
  }
  const vbriOffset = frame.offset + 4 + 32;
  if (vbriOffset + 4 <= frame.offset + frame.frameSize) {
    const tag = String.fromCharCode(
      bytes[vbriOffset],
      bytes[vbriOffset + 1],
      bytes[vbriOffset + 2],
      bytes[vbriOffset + 3]
    );
    if (tag === 'VBRI') return true;
  }
  return false;
}

function readBits(bytes: Uint8Array, startByte: number, bitOffset: number, bitCount: number): number {
  let value = 0;
  for (let i = 0; i < bitCount; i++) {
    const absBit = bitOffset + i;
    const byteIdx = startByte + (absBit >> 3);
    const bitInByte = 7 - (absBit & 7);
    value = (value << 1) | ((bytes[byteIdx] >> bitInByte) & 1);
  }
  return value;
}

function writeBits(
  bytes: Uint8Array,
  startByte: number,
  bitOffset: number,
  bitCount: number,
  value: number
): void {
  for (let i = 0; i < bitCount; i++) {
    const absBit = bitOffset + i;
    const byteIdx = startByte + (absBit >> 3);
    const bitInByte = 7 - (absBit & 7);
    const bitVal = (value >> (bitCount - 1 - i)) & 1;
    if (bitVal) {
      bytes[byteIdx] |= 1 << bitInByte;
    } else {
      bytes[byteIdx] &= ~(1 << bitInByte);
    }
  }
}

/**
 * Standard MPEG Audio CRC-16/IBM (polynomial 0x8005, init 0xFFFF)
 * covers header bytes [2, 3] and the full sideInfoBytes block.
 */
function updateFrameCrc16(bytes: Uint8Array, frame: ParsedFrameHeader): void {
  let crc = 0xffff;
  const feedByte = (byte: number) => {
    for (let bit = 0x80; bit !== 0; bit >>= 1) {
      const msb = (crc & 0x8000) !== 0;
      const dataBit = (byte & bit) !== 0;
      crc = (crc << 1) & 0xffff;
      if (msb !== dataBit) {
        crc ^= 0x8005;
      }
    }
  };

  feedByte(bytes[frame.offset + 2]);
  feedByte(bytes[frame.offset + 3]);
  const sideStart = frame.offset + 6;
  for (let i = 0; i < frame.sideInfoBytes; i++) {
    feedByte(bytes[sideStart + i]);
  }

  bytes[frame.offset + 4] = (crc >> 8) & 0xff;
  bytes[frame.offset + 5] = crc & 0xff;
}

export function scanMp3AudioStream(
  bytes: Uint8Array,
  audioStartOffset: number,
  audioEndOffset: number
): Mp3StreamScanResult {
  let pos = audioStartOffset;
  let frameCount = 0;
  let totalBitrate = 0;
  let firstBitrate = 0;
  let isVbr = false;
  let hasCrc = false;
  let mpegVersion = 1;
  let sampleRate = 44100;

  while (pos + 4 <= audioEndOffset) {
    const frame = parseFrameHeader(bytes, pos);
    if (!frame || pos + frame.frameSize > audioEndOffset) {
      pos++;
      continue;
    }

    if (frameCount === 0) {
      mpegVersion = frame.versionBits === 3 ? 1 : 2;
      sampleRate = frame.sampleRate;
      hasCrc = frame.hasCrc;
      if (isXingOrVbriFrame(bytes, frame)) {
        isVbr = true;
      }
      firstBitrate = frame.bitrateKbps;
    } else if (frame.bitrateKbps !== firstBitrate) {
      isVbr = true;
    }

    frameCount++;
    totalBitrate += frame.bitrateKbps;
    pos += frame.frameSize;
  }

  return {
    frameCount,
    detectedBitrateKbps: frameCount > 0 ? Math.round(totalBitrate / frameCount) : null,
    isVbr,
    hasCrc,
    mpegVersion,
    sampleRate,
  };
}

/**
 * Losslessly modifies MP3 `global_gain` fields in every MPEG Layer III frame
 * by `steps` increments (+1 step = +1.50515 dB).
 * Preserves 100% of ID3v2 header, ID3v1/APEv2 tail, and audio Huffman bitstream.
 */
export function applyLosslessMp3FrameGain(
  originalBytes: Uint8Array,
  audioStartOffset: number,
  audioEndOffset: number,
  steps: number
): { outputBytes: Uint8Array; modifiedFrames: number } {
  // Clone exact file so ID3v2 header + ID3v1/APE tail remain 100% untouched byte-for-byte
  const out = new Uint8Array(originalBytes);
  if (steps === 0) {
    return { outputBytes: out, modifiedFrames: 0 };
  }

  let pos = audioStartOffset;
  let modifiedFrames = 0;
  let frameIdx = 0;

  while (pos + 4 <= audioEndOffset) {
    const frame = parseFrameHeader(out, pos);
    if (!frame || pos + frame.frameSize > audioEndOffset) {
      pos++;
      continue;
    }

    // Never patch a Xing / Info / VBRI metadata frame
    if (frameIdx === 0 && isXingOrVbriFrame(out, frame)) {
      frameIdx++;
      pos += frame.frameSize;
      continue;
    }

    const sideStart = frame.offset + 4 + (frame.hasCrc ? 2 : 0);
    if (sideStart + frame.sideInfoBytes > frame.offset + frame.frameSize) {
      break;
    }

    let touched = false;
    if (frame.versionBits === 3) {
      // MPEG-1 Layer III: 9 bits main_data_begin + (5 mono / 3 stereo) private_bits + 4*ch scfsi
      const headerBits = 9 + (frame.channels === 1 ? 5 : 3) + 4 * frame.channels;
      const granuleChannelBits = 59;

      for (let gr = 0; gr < 2; gr++) {
        for (let ch = 0; ch < frame.channels; ch++) {
          const blockBitStart = headerBits + (gr * frame.channels + ch) * granuleChannelBits;
          const part23Len = readBits(out, sideStart, blockBitStart, 12);
          const gainBitOffset = blockBitStart + 21; // 12 (part2_3_length) + 9 (big_values)
          const oldGain = readBits(out, sideStart, gainBitOffset, 8);

          // Leave silent granules untouched (oldGain === 0 or part23Len === 0)
          if (oldGain > 0 && part23Len > 0) {
            const newGain = Math.max(1, Math.min(255, oldGain + steps));
            if (newGain !== oldGain) {
              writeBits(out, sideStart, gainBitOffset, 8, newGain);
              touched = true;
            }
          }
        }
      }
    } else {
      // MPEG-2 / 2.5 Layer III: 8 bits main_data_begin + (1 mono / 2 stereo) private_bits, 1 granule
      const headerBits = 8 + (frame.channels === 1 ? 1 : 2);
      const channelBits = 63;

      for (let ch = 0; ch < frame.channels; ch++) {
        const blockBitStart = headerBits + ch * channelBits;
        const part23Len = readBits(out, sideStart, blockBitStart, 12);
        const gainBitOffset = blockBitStart + 21;
        const oldGain = readBits(out, sideStart, gainBitOffset, 8);

        if (oldGain > 0 && part23Len > 0) {
          const newGain = Math.max(1, Math.min(255, oldGain + steps));
          if (newGain !== oldGain) {
            writeBits(out, sideStart, gainBitOffset, 8, newGain);
            touched = true;
          }
        }
      }
    }

    if (touched) {
      if (frame.hasCrc) {
        updateFrameCrc16(out, frame);
      }
      modifiedFrames++;
    }

    frameIdx++;
    pos += frame.frameSize;
  }

  return { outputBytes: out, modifiedFrames };
}
