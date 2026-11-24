import type {
  AudioAnalysisMetrics,
  ComputedTrackGain,
  NormalizationSettings,
} from '../types/audio';

export const LOSSLESS_STEP_DB = 20 * Math.log10(Math.pow(2, 0.25)); // ~1.50515 dB

interface BiquadCoeffs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/**
 * ITU-R BS.1770-4 Stage 1 (Pre-filter high shelf) and Stage 2 (RLB high-pass)
 * computed via bilinear transform for arbitrary sample rates (44.1 kHz, 48 kHz, etc.)
 */
function getKWeightingFilters(fs: number): { stage1: BiquadCoeffs; stage2: BiquadCoeffs } {
  // Stage 1: +4 dB high-shelf at ~1681.97 Hz, Q = 0.7071752369554196
  const f0_1 = 1681.974450955533;
  const G = 3.999843853973347;
  const Q_1 = 0.7071752369554196;
  const K1 = Math.tan((Math.PI * f0_1) / fs);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  const a0_1 = 1 + K1 / Q_1 + K1 * K1;

  const stage1: BiquadCoeffs = {
    b0: (Vh + (Vb * K1) / Q_1 + K1 * K1) / a0_1,
    b1: (2 * (K1 * K1 - Vh)) / a0_1,
    b2: (Vh - (Vb * K1) / Q_1 + K1 * K1) / a0_1,
    a1: (2 * (K1 * K1 - 1)) / a0_1,
    a2: (1 - K1 / Q_1 + K1 * K1) / a0_1,
  };

  // Stage 2: RLB 2nd-order high-pass at ~38.135 Hz, Q = 0.5003270373238773
  const f0_2 = 38.13547087602444;
  const Q_2 = 0.5003270373238773;
  const K2 = Math.tan((Math.PI * f0_2) / fs);
  const a0_2 = 1 + K2 / Q_2 + K2 * K2;

  const stage2: BiquadCoeffs = {
    b0: 1 / a0_2,
    b1: -2 / a0_2,
    b2: 1 / a0_2,
    a1: (2 * (K2 * K2 - 1)) / a0_2,
    a2: (1 - K2 / Q_2 + K2 * K2) / a0_2,
  };

  return { stage1, stage2 };
}

/**
 * 4x oversampled True Peak estimation using Catmull-Rom cubic spline interpolation
 */
function measureTruePeakLinear(channels: Float32Array[]): {
  samplePeak: number;
  truePeak: number;
} {
  let samplePeak = 0;
  let truePeak = 0;

  for (let c = 0; c < channels.length; c++) {
    const data = channels[c];
    const len = data.length;
    for (let i = 0; i < len; i++) {
      const abs0 = Math.abs(data[i]);
      if (abs0 > samplePeak) samplePeak = abs0;
      if (abs0 > truePeak) truePeak = abs0;

      if (i >= 1 && i + 2 < len && abs0 > 0.25 * truePeak) {
        const ym1 = data[i - 1];
        const y0 = data[i];
        const y1 = data[i + 1];
        const y2 = data[i + 2];

        const c0 = y0;
        const c1 = 0.5 * (y1 - ym1);
        const c2 = ym1 - 2.5 * y0 + 2 * y1 - 0.5 * y2;
        const c3 = 0.5 * (y2 - ym1) + 1.5 * (y0 - y1);

        for (let k = 1; k <= 3; k++) {
          const t = k * 0.25;
          const interp = Math.abs(((c3 * t + c2) * t + c1) * t + c0);
          if (interp > truePeak) truePeak = interp;
        }
      }
    }
  }

  return {
    samplePeak: Math.max(samplePeak, 1e-7),
    truePeak: Math.max(truePeak, 1e-7),
  };
}

/**
 * Computes ITU-R BS.1770-4 Integrated Loudness (LUFS) in a single O(1)-memory streaming pass
 * by accumulating 100 ms sub-block squared energies and sliding 4x100 ms = 400 ms gating blocks.
 */
function measureIntegratedLufs(channels: Float32Array[], sampleRate: number): number {
  const numChannels = channels.length;
  if (numChannels === 0 || channels[0].length === 0) return -70;

  const { stage1, stage2 } = getKWeightingFilters(sampleRate);
  const totalSamples = channels[0].length;
  const hopSamples = Math.max(1, Math.round(0.1 * sampleRate)); // 100 ms sub-block
  const blockSamples = hopSamples * 4; // 400 ms gating block
  const numSubBlocks = Math.floor(totalSamples / hopSamples);
  const weights = channels.map((_, idx) => (idx >= 3 ? 1.41 : 1.0));

  if (numSubBlocks < 4) {
    let sumEnergy = 0;
    for (let c = 0; c < numChannels; c++) {
      const src = channels[c];
      let x1_1 = 0, x2_1 = 0, y1_1 = 0, y2_1 = 0;
      let x1_2 = 0, x2_2 = 0, y1_2 = 0, y2_2 = 0;
      let sq = 0;
      for (let i = 0; i < totalSamples; i++) {
        const x = src[i];
        const y1 = stage1.b0 * x + stage1.b1 * x1_1 + stage1.b2 * x2_1 - stage1.a1 * y1_1 - stage1.a2 * y2_1;
        x2_1 = x1_1; x1_1 = x; y2_1 = y1_1; y1_1 = y1;
        const y2 = stage2.b0 * y1 + stage2.b1 * x1_2 + stage2.b2 * x2_2 - stage2.a1 * y1_2 - stage2.a2 * y2_2;
        x2_2 = x1_2; x1_2 = y1; y2_2 = y1_2; y1_2 = y2;
        sq += y2 * y2;
      }
      sumEnergy += weights[c] * (sq / Math.max(1, totalSamples));
    }
    if (sumEnergy <= 1e-12) return -70;
    return -0.691 + 10 * Math.log10(sumEnergy);
  }

  // Weighted energy per 100 ms sub-block (~20 KB for a 5-minute song!)
  const subBlockWeightedSq = new Float64Array(numSubBlocks);

  for (let c = 0; c < numChannels; c++) {
    const src = channels[c];
    const w = weights[c];
    let x1_1 = 0, x2_1 = 0, y1_1 = 0, y2_1 = 0;
    let x1_2 = 0, x2_2 = 0, y1_2 = 0, y2_2 = 0;

    for (let sb = 0; sb < numSubBlocks; sb++) {
      const start = sb * hopSamples;
      const end = start + hopSamples;
      let sq = 0;
      for (let i = start; i < end; i++) {
        const x = src[i];
        const y1 = stage1.b0 * x + stage1.b1 * x1_1 + stage1.b2 * x2_1 - stage1.a1 * y1_1 - stage1.a2 * y2_1;
        x2_1 = x1_1; x1_1 = x; y2_1 = y1_1; y1_1 = y1;
        const y2 = stage2.b0 * y1 + stage2.b1 * x1_2 + stage2.b2 * x2_2 - stage2.a1 * y1_2 - stage2.a2 * y2_2;
        x2_2 = x1_2; x1_2 = y1; y2_2 = y1_2; y1_2 = y2;
        sq += y2 * y2;
      }
      subBlockWeightedSq[sb] += w * sq;
    }
  }

  const blockLoudnesses: number[] = [];
  const blockEnergies: number[] = [];

  for (let sb = 0; sb + 3 < numSubBlocks; sb++) {
    const sumSq =
      subBlockWeightedSq[sb] +
      subBlockWeightedSq[sb + 1] +
      subBlockWeightedSq[sb + 2] +
      subBlockWeightedSq[sb + 3];
    const meanEnergy = sumSq / blockSamples;
    const lufs = meanEnergy > 1e-12 ? -0.691 + 10 * Math.log10(meanEnergy) : -120;
    if (lufs > -70) {
      blockLoudnesses.push(lufs);
      blockEnergies.push(meanEnergy);
    }
  }

  if (blockEnergies.length === 0) return -70;

  let absMeanEnergy = 0;
  for (let i = 0; i < blockEnergies.length; i++) absMeanEnergy += blockEnergies[i];
  absMeanEnergy /= blockEnergies.length;

  const relativeThreshold = -0.691 + 10 * Math.log10(absMeanEnergy) - 10;

  let relSum = 0;
  let relCount = 0;
  for (let i = 0; i < blockLoudnesses.length; i++) {
    if (blockLoudnesses[i] >= relativeThreshold) {
      relSum += blockEnergies[i];
      relCount++;
    }
  }

  if (relCount === 0) return -70;
  const finalMeanEnergy = relSum / relCount;
  return Math.max(-70, -0.691 + 10 * Math.log10(finalMeanEnergy));
}

function buildWaveformPeaks(channels: Float32Array[], bucketCount = 84): Float32Array {
  const out = new Float32Array(bucketCount);
  if (channels.length === 0 || channels[0].length === 0) return out;
  const totalSamples = channels[0].length;
  const step = Math.max(1, Math.floor(totalSamples / bucketCount));

  for (let b = 0; b < bucketCount; b++) {
    const start = b * step;
    const end = Math.min(totalSamples, start + step);
    const stride = Math.max(1, Math.floor((end - start) / 64));
    let maxVal = 0;
    for (let c = 0; c < channels.length; c++) {
      const ch = channels[c];
      for (let i = start; i < end; i += stride) {
        const v = Math.abs(ch[i]);
        if (v > maxVal) maxVal = v;
      }
    }
    out[b] = Math.min(1, maxVal);
  }
  return out;
}

export function analyzeAudioBuffer(
  audioBuffer: AudioBuffer,
  mp3Info?: { detectedBitrateKbps: number | null; isVbr: boolean; hasCrc: boolean }
): { metrics: AudioAnalysisMetrics } {
  const channels: Float32Array[] = [];
  for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
    channels.push(audioBuffer.getChannelData(c));
  }

  const { samplePeak, truePeak } = measureTruePeakLinear(channels);
  const samplePeakDb = 20 * Math.log10(samplePeak);
  const truePeakDb = 20 * Math.log10(truePeak);
  const integratedLufs = measureIntegratedLufs(channels, audioBuffer.sampleRate);
  const maxSafeGainDb = 0.0 - truePeakDb;
  const waveformPeaks = buildWaveformPeaks(channels, 84);

  return {
    metrics: {
      sampleRate: audioBuffer.sampleRate,
      channels: audioBuffer.numberOfChannels,
      durationSeconds: audioBuffer.duration,
      samplePeakDb,
      truePeakDb,
      integratedLufs,
      maxSafeGainDb,
      waveformPeaks,
      detectedBitrateKbps: mp3Info?.detectedBitrateKbps ?? null,
      isVbr: mp3Info?.isVbr ?? false,
      hasCrc: mp3Info?.hasCrc ?? false,
    },
  };
}

export function computeTrackGain(
  analysis: AudioAnalysisMetrics,
  settings: NormalizationSettings,
  manualOverrideDb: number | null,
  isMp3: boolean
): ComputedTrackGain {
  const ceilingDb =
    settings.targetMode === 'peak' ? settings.targetPeakDb : settings.lufsPeakCeilingDb;

  let requestedGainDb: number;
  if (manualOverrideDb !== null) {
    requestedGainDb = manualOverrideDb;
  } else if (settings.targetMode === 'peak') {
    requestedGainDb = settings.targetPeakDb - analysis.truePeakDb;
  } else {
    requestedGainDb = settings.targetLufs - analysis.integratedLufs;
  }

  // Max gain allowed before exceeding ceilingDb
  const maxGainUnderCeiling = ceilingDb - analysis.truePeakDb;

  if (settings.engineMode === 'lossless' && isMp3) {
    // Quantize to 1.505 dB steps
    let steps = Math.round(requestedGainDb / LOSSLESS_STEP_DB);
    // In lossless mode there is NO limiter; never allow positive gain to push True Peak above ceiling if clamped
    if (settings.clipProtection === 'clamp' || manualOverrideDb === null) {
      const maxSafeSteps = Math.floor(maxGainUnderCeiling / LOSSLESS_STEP_DB);
      if (steps > maxSafeSteps) {
        steps = maxSafeSteps;
      }
    }
    const appliedGainDb = steps * LOSSLESS_STEP_DB;
    const projectedTruePeakDb = analysis.truePeakDb + appliedGainDb;
    const projectedLufs = analysis.integratedLufs + appliedGainDb;
    return {
      requestedGainDb,
      appliedGainDb,
      losslessSteps: steps,
      limitingRequiredDb: 0,
      wouldClip: projectedTruePeakDb > 0.01,
      projectedTruePeakDb,
      projectedLufs,
    };
  }

  // Exact 0.1 dB mode (with optional Lookahead Limiter or Strict Peak Clamp)
  let appliedGainDb = Math.round(requestedGainDb * 10) / 10;
  let limitingRequiredDb = 0;

  const rawProjectedPeak = analysis.truePeakDb + appliedGainDb;
  if (rawProjectedPeak > ceilingDb) {
    if (settings.clipProtection === 'clamp') {
      appliedGainDb = Math.floor(maxGainUnderCeiling * 10) / 10;
    } else {
      // Lookahead limiter caps peaks cleanly at ceilingDb while keeping gain
      limitingRequiredDb = rawProjectedPeak - ceilingDb;
    }
  }

  const finalProjectedPeak =
    settings.clipProtection === 'limiter' && analysis.truePeakDb + appliedGainDb > ceilingDb
      ? ceilingDb
      : analysis.truePeakDb + appliedGainDb;

  // Approximate loudness reduction if heavy limiting occurs
  const projectedLufs =
    analysis.integratedLufs + appliedGainDb - Math.max(0, limitingRequiredDb * 0.35);

  return {
    requestedGainDb,
    appliedGainDb,
    losslessSteps: Math.round(appliedGainDb / LOSSLESS_STEP_DB),
    limitingRequiredDb,
    wouldClip: false, // Protected by clamp or limiter in exact mode
    projectedTruePeakDb: finalProjectedPeak,
    projectedLufs,
  };
}
