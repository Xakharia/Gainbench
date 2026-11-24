export type TargetMode = 'peak' | 'lufs';

export type Mp3EngineMode = 'exact' | 'lossless';

export type ClipProtectionMode = 'limiter' | 'clamp';

export type OutputBitrateOption = 'match' | 320 | 256 | 192;

export type ExportNamingMode = 'folder_music_normalized' | 'replace' | 'norm_suffix';

export type AudioContainerFormat = 'mp3' | 'm4a' | 'aac' | 'wav' | 'other';

export interface Id3ArtworkInfo {
  mimeType: string;
  description: string;
  pictureType: number;
  byteLength: number;
  objectUrl: string;
}

export interface Id3LyricsInfo {
  language: string;
  description: string;
  text: string;
  isSynchronized: boolean;
  byteLength: number;
}

export interface ParsedId3Metadata {
  hasId3v2: boolean;
  id3v2Version: string | null;
  id3v2ByteLength: number;
  hasId3v1: boolean;
  hasApeOrLyricsTail: boolean;
  tailByteLength: number;
  audioStartOffset: number;
  audioEndOffset: number;
  title: string;
  artist: string;
  album: string;
  year: string;
  frameIds: string[];
  artwork: Id3ArtworkInfo | null;
  lyrics: Id3LyricsInfo | null;
  /** Exact untouched original ID3v2 header bytes [0..audioStartOffset] */
  rawHeaderBytes: Uint8Array;
  /** Exact untouched original ID3v1 / APEv2 / Lyrics3 tail bytes [audioEndOffset..end] */
  rawTailBytes: Uint8Array;
}

export interface AudioAnalysisMetrics {
  sampleRate: number;
  channels: number;
  durationSeconds: number;
  samplePeakDb: number;
  truePeakDb: number;
  integratedLufs: number;
  /** Maximum gain in dB before True Peak reaches 0.0 dBTP */
  maxSafeGainDb: number;
  /** Downsampled peak amplitudes [0..1] for waveform rendering */
  waveformPeaks: Float32Array;
  /** Detected source bitrate in kbps (for MP3) */
  detectedBitrateKbps: number | null;
  isVbr: boolean;
  hasCrc: boolean;
}

export interface TrackItem {
  id: string;
  file: File;
  fileName: string;
  fileSizeBytes: number;
  format: AudioContainerFormat;
  fileHandle?: FileSystemFileHandle;
  parentDirHandle?: FileSystemDirectoryHandle;
  selected: boolean;
  status: 'analyzing' | 'ready' | 'processing' | 'done' | 'error';
  errorMessage?: string;
  metadata: ParsedId3Metadata | null;
  analysis: AudioAnalysisMetrics | null;
  /** Decoded PCM channels retained locally for instant preview & exact re-encode */
  pcmChannels?: Float32Array[];
  /** Raw original file bytes */
  rawBytes?: Uint8Array;
  /** Optional user override in dB (null = use automatic target calculation) */
  manualGainOverrideDb: number | null;
  /** Last export verification result */
  exportResult?: {
    outputFileName: string;
    outputSizeBytes: number;
    appliedGainDb: number;
    limitingUsedDb: number;
    id3PreservedBytes: number;
    tailPreservedBytes: number;
    modeUsed: Mp3EngineMode;
    actionTaken: 'saved_to_music_normalized' | 'replaced' | 'created_norm' | 'downloaded';
  };
}

export interface NormalizationSettings {
  targetMode: TargetMode;
  /** Target Peak Ceiling in dBTP (typically -3.0 to 0.0) */
  targetPeakDb: number;
  /** Target Integrated Loudness in LUFS (typically -23.0 to -8.0) */
  targetLufs: number;
  /** Safety ceiling in dBTP used when targetMode === 'lufs' */
  lufsPeakCeilingDb: number;
  /** MP3 processing engine */
  engineMode: Mp3EngineMode;
  /** In exact mode: 'limiter' keeps target LUFS via lookahead limiter; 'clamp' stops at peak ceiling */
  clipProtection: ClipProtectionMode;
  /** Bitrate for exact re-encode */
  outputBitrate: OutputBitrateOption;
}

export interface ComputedTrackGain {
  /** Ideal gain requested by target (or manual override) */
  requestedGainDb: number;
  /** Actual gain that will be applied after engine quantization / clamping */
  appliedGainDb: number;
  /** For lossless 1.5 dB mode: integer step count (-16..+16) */
  losslessSteps: number;
  /** Amount of transient peak limiting required (dB > 0 only in exact limiter mode) */
  limitingRequiredDb: number;
  /** Whether output would clip (> 0.0 dBTP) if unclamped/unprotected */
  wouldClip: boolean;
  /** Projected output True Peak in dBTP */
  projectedTruePeakDb: number;
  /** Projected output Integrated LUFS */
  projectedLufs: number;
}
