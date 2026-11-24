import { Mp3Encoder } from '@breezystack/lamejs';
import type {
  ComputedTrackGain,
  NormalizationSettings,
  TrackItem,
} from '../types/audio';
import { applyLosslessMp3FrameGain } from './mp3FrameGain';

const VALID_MP3_BITRATES = [64, 80, 96, 112, 128, 160, 192, 224, 256, 320];

function snapMp3Bitrate(detectedKbps: number | null, preference: NormalizationSettings['outputBitrate']): number {
  if (preference !== 'match') return preference;
  if (!detectedKbps || detectedKbps <= 0) return 320;
  // Choose the smallest standard bitrate >= detected (to prevent quality loss)
  for (const br of VALID_MP3_BITRATES) {
    if (br >= detectedKbps - 8) return br;
  }
  return 320;
}

/**
 * O(N) Monotonic-deque 5ms lookahead true-peak envelope + smooth 60ms release limiter.
 * Guarantees output peaks never exceed `ceilingDb` while preserving transparent transients.
 */
export function processPcmWithGainAndLimiter(
  channels: Float32Array[],
  sampleRate: number,
  gainDb: number,
  ceilingDb: number,
  useLimiter: boolean
): { processed: Float32Array[]; maxReductionDb: number } {
  const numCh = channels.length;
  const len = channels[0]?.length ?? 0;
  const linearGain = Math.pow(10, gainDb / 20);
  const ceilingLin = Math.pow(10, ceilingDb / 20);

  const out = channels.map((ch) => new Float32Array(ch.length));
  if (len === 0) return { processed: out, maxReductionDb: 0 };

  if (!useLimiter) {
    for (let c = 0; c < numCh; c++) {
      const src = channels[c];
      const dst = out[c];
      for (let i = 0; i < len; i++) {
        dst[i] = Math.max(-0.9999, Math.min(0.9999, src[i] * linearGain));
      }
    }
    return { processed: out, maxReductionDb: 0 };
  }

  // Linked stereo/multi-channel peak array scaled by linearGain
  const scaledPeak = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    let pk = 0;
    for (let c = 0; c < numCh; c++) {
      const v = Math.abs(channels[c][i]) * linearGain;
      if (v > pk) pk = v;
    }
    scaledPeak[i] = pk;
  }

  // 5ms lookahead window max using monotonic deque (O(N))
  const lookahead = Math.max(1, Math.round(0.005 * sampleRate));
  const futureMax = new Float32Array(len);
  const deque = new Int32Array(len);
  let head = 0;
  let tail = 0;

  // Prime first `lookahead` samples
  const primeEnd = Math.min(len, lookahead);
  for (let j = 0; j < primeEnd; j++) {
    while (tail > head && scaledPeak[deque[tail - 1]] <= scaledPeak[j]) {
      tail--;
    }
    deque[tail++] = j;
  }

  for (let i = 0; i < len; i++) {
    const enterIdx = i + lookahead;
    if (enterIdx < len) {
      while (tail > head && scaledPeak[deque[tail - 1]] <= scaledPeak[enterIdx]) {
        tail--;
      }
      deque[tail++] = enterIdx;
    }
    while (tail > head && deque[head] < i) {
      head++;
    }
    futureMax[i] = head < tail ? scaledPeak[deque[head]] : scaledPeak[i];
  }

  // Smooth attack/release gain envelope
  const attackCoeff = Math.exp(-1 / (0.0015 * sampleRate));
  const releaseCoeff = Math.exp(-1 / (0.065 * sampleRate));
  let envGain = 1.0;
  let minEnvGain = 1.0;

  for (let i = 0; i < len; i++) {
    const pk = futureMax[i];
    const targetGain = pk > ceilingLin ? ceilingLin / pk : 1.0;

    if (targetGain < envGain) {
      envGain = attackCoeff * envGain + (1 - attackCoeff) * targetGain;
    } else {
      envGain = releaseCoeff * envGain + (1 - releaseCoeff) * targetGain;
    }

    // Hard safety guard so inter-attack transient never overshoots ceilingLin
    const instPeak = scaledPeak[i];
    const safeGain = instPeak * envGain > ceilingLin ? ceilingLin / instPeak : envGain;
    if (safeGain < minEnvGain) minEnvGain = safeGain;

    const totalGain = linearGain * safeGain;
    for (let c = 0; c < numCh; c++) {
      out[c][i] = Math.max(-ceilingLin, Math.min(ceilingLin, channels[c][i] * totalGain));
    }
  }

  const maxReductionDb = minEnvGain < 0.9999 ? -20 * Math.log10(minEnvGain) : 0;
  return { processed: out, maxReductionDb };
}

function float32ToInt16(src: Float32Array): Int16Array {
  const out = new Int16Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const s = Math.max(-1, Math.min(1, src[i]));
    out[i] = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
  }
  return out;
}

export interface ProcessTrackOutput {
  bytes: Uint8Array;
  outputFileName: string;
  appliedGainDb: number;
  limitingUsedDb: number;
  id3PreservedBytes: number;
  tailPreservedBytes: number;
}

export async function processTrackToMp3(
  track: TrackItem,
  computed: ComputedTrackGain,
  settings: NormalizationSettings,
  addNormSuffix: boolean,
  onProgress?: (pct: number) => void
): Promise<ProcessTrackOutput> {
  if (!track.analysis || !track.metadata) {
    throw new Error('Track has not finished analysis yet.');
  }

  const baseName = track.fileName.replace(/\.[^/.]+$/, '');
  const outputFileName = addNormSuffix ? `${baseName}_norm.mp3` : `${baseName}.mp3`;

  const id3PreservedBytes = track.metadata.rawHeaderBytes.length;
  const tailPreservedBytes = track.metadata.rawTailBytes.length;

  // Mode 1: Lossless 1.5 dB MP3 Frame Gain Patching (no re-encode)
  if (settings.engineMode === 'lossless' && track.format === 'mp3') {
    onProgress?.(25);
    const sourceBytes = track.rawBytes ?? new Uint8Array(await track.file.arrayBuffer());
    const { outputBytes } = applyLosslessMp3FrameGain(
      sourceBytes,
      track.metadata.audioStartOffset,
      track.metadata.audioEndOffset,
      computed.losslessSteps
    );
    onProgress?.(100);
    return {
      bytes: outputBytes,
      outputFileName,
      appliedGainDb: computed.appliedGainDb,
      limitingUsedDb: 0,
      id3PreservedBytes,
      tailPreservedBytes,
    };
  }

  // Mode 2: Exact 0.1 dB Gain + Lookahead Limiter + High-Bitrate LAME Encode + Untouched ID3 Stitching
  onProgress?.(10);
  let pcmChannels = track.pcmChannels;
  let sampleRate = track.analysis.sampleRate;
  if (!pcmChannels || pcmChannels.length === 0) {
    const decodeCtx = new AudioContext();
    try {
      const arrayBuf = await track.file.arrayBuffer();
      const decoded = await decodeCtx.decodeAudioData(arrayBuf.slice(0));
      sampleRate = decoded.sampleRate;
      const arr: Float32Array[] = [];
      for (let c = 0; c < decoded.numberOfChannels; c++) {
        arr.push(new Float32Array(decoded.getChannelData(c)));
      }
      pcmChannels = arr;
    } finally {
      await decodeCtx.close();
    }
  }

  onProgress?.(20);
  const ceilingDb =
    settings.targetMode === 'peak' ? settings.targetPeakDb : settings.lufsPeakCeilingDb;
  const useLimiter = settings.clipProtection === 'limiter';

  const { processed, maxReductionDb } = processPcmWithGainAndLimiter(
    pcmChannels,
    sampleRate,
    computed.appliedGainDb,
    ceilingDb,
    useLimiter
  );

  onProgress?.(35);

  const channels = Math.min(2, processed.length);
  const leftInt16 = float32ToInt16(processed[0]);
  const rightInt16 = channels > 1 ? float32ToInt16(processed[1]) : undefined;

  const targetBitrate = snapMp3Bitrate(
    track.analysis.detectedBitrateKbps,
    settings.outputBitrate
  );
  const encoder = new Mp3Encoder(channels, track.analysis.sampleRate, targetBitrate);

  const mp3Chunks: Uint8Array[] = [];
  const blockSize = 1152;
  const totalSamples = leftInt16.length;
  let chunkCounter = 0;

  for (let i = 0; i < totalSamples; i += blockSize) {
    const end = Math.min(totalSamples, i + blockSize);
    const leftChunk = leftInt16.subarray(i, end);
    const rightChunk = rightInt16 ? rightInt16.subarray(i, end) : undefined;
    const mp3buf = encoder.encodeBuffer(leftChunk, rightChunk);
    if (mp3buf.length > 0) {
      mp3Chunks.push(new Uint8Array(mp3buf));
    }

    chunkCounter++;
    if (chunkCounter % 80 === 0) {
      const pct = 35 + Math.round((i / totalSamples) * 60);
      onProgress?.(pct);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }

  const flushBuf = encoder.flush();
  if (flushBuf.length > 0) {
    mp3Chunks.push(new Uint8Array(flushBuf));
  }

  // Stitch: [exact original ID3v2 header] + [encoded MP3 audio frames] + [exact original ID3v1/APE tail]
  const rawHeader = track.format === 'mp3' ? track.metadata.rawHeaderBytes : new Uint8Array(0);
  const rawTail = track.format === 'mp3' ? track.metadata.rawTailBytes : new Uint8Array(0);

  let audioByteLen = 0;
  for (const c of mp3Chunks) audioByteLen += c.length;

  const finalBytes = new Uint8Array(rawHeader.length + audioByteLen + rawTail.length);
  let writePos = 0;
  if (rawHeader.length > 0) {
    finalBytes.set(rawHeader, writePos);
    writePos += rawHeader.length;
  }
  for (const c of mp3Chunks) {
    finalBytes.set(c, writePos);
    writePos += c.length;
  }
  if (rawTail.length > 0) {
    finalBytes.set(rawTail, writePos);
  }

  onProgress?.(100);

  return {
    bytes: finalBytes,
    outputFileName,
    appliedGainDb: computed.appliedGainDb,
    limitingUsedDb: maxReductionDb,
    id3PreservedBytes: rawHeader.length,
    tailPreservedBytes: rawTail.length,
  };
}
