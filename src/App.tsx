import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Download,
  FolderOpen,
  Info,
  ShieldCheck,
  Sliders,
  Upload,
} from 'lucide-react';
import {
  detectFileSystemCapabilities,
  extractDroppedAudioFiles,
  pickFilesWithHandles,
  pickFolderWithHandles,
  type PickedAudioFile,
} from './audio/fileHandles';
import { parseId3AndMetadata } from './audio/id3Parser';
import { analyzeAudioBuffer } from './audio/loudnessAnalyzer';
import { scanMp3AudioStream } from './audio/mp3FrameGain';
import { useAudioPreview } from './audio/useAudioPreview';
import { ControlRack } from './components/ControlRack';
import { ExportModal } from './components/ExportModal';
import { Header } from './components/Header';
import { MetadataInspector } from './components/MetadataInspector';
import { TrackList } from './components/TrackList';
import type {
  AudioContainerFormat,
  NormalizationSettings,
  TrackItem,
} from './types/audio';

function detectContainerFormat(fileName: string, mimeType = ''): AudioContainerFormat {
  const lower = fileName.toLowerCase();
  const mime = mimeType.toLowerCase();
  if (lower.endsWith('.mp3') || mime === 'audio/mpeg' || mime === 'audio/mp3') return 'mp3';
  if (lower.endsWith('.m4a') || lower.endsWith('.mp4') || mime === 'audio/mp4' || mime === 'audio/x-m4a') return 'm4a';
  if (lower.endsWith('.aac') || mime === 'audio/aac' || mime === 'audio/aacp') return 'aac';
  if (lower.endsWith('.wav') || mime === 'audio/wav' || mime === 'audio/x-wav') return 'wav';
  return 'other';
}

function isSupportedAudioFile(file: File): boolean {
  const lower = file.name.toLowerCase();
  const mime = (file.type || '').toLowerCase();
  if (
    lower.endsWith('.mp3') ||
    lower.endsWith('.m4a') ||
    lower.endsWith('.mp4') ||
    lower.endsWith('.aac') ||
    lower.endsWith('.wav') ||
    lower.endsWith('.ogg') ||
    lower.endsWith('.flac') ||
    lower.endsWith('.opus') ||
    lower.endsWith('.webm')
  ) {
    return true;
  }
  return mime.startsWith('audio/');
}

function makeTrackId(fileName: string, size: number, index: number): string {
  const rand =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `${fileName}-${size}-${index}-${rand}`;
}

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      message: error?.message || 'Unexpected rendering error.',
    };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#0b0f17] flex items-center justify-center p-6">
          <div className="bg-[#111827] border border-slate-800 rounded-xl max-w-md w-full p-6 space-y-4">
            <h1 className="font-display text-lg font-semibold text-white">
              Something went wrong
            </h1>
            <p className="text-sm text-slate-300">{this.state.message}</p>
            <button
              type="button"
              onClick={() => this.setState({ hasError: false, message: '' })}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-500 rounded-lg cursor-pointer"
            >
              Reset View
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  return (
    <AppErrorBoundary>
      <GainBenchApp />
    </AppErrorBoundary>
  );
}

function GainBenchApp() {
  const [activeSection, setActiveSection] = useState<
    'workspace' | 'preservation' | 'engine'
  >('workspace');

  const [tracks, setTracks] = useState<TrackItem[]>([]);
  const [settings, setSettings] = useState<NormalizationSettings>({
    targetMode: 'peak',
    targetPeakDb: -0.5,
    targetLufs: -14.0,
    lufsPeakCeilingDb: -1.0,
    engineMode: 'exact',
    clipProtection: 'limiter',
    outputBitrate: 'match',
  });

  const [isDraggingTop, setIsDraggingTop] = useState(false);
  const [inspectedTrackId, setInspectedTrackId] = useState<string | null>(null);
  const [isExportOpen, setIsExportOpen] = useState(false);
  const [pickerNotice, setPickerNotice] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const decodeCtxRef = useRef<AudioContext | null>(null);

  const fsCaps = useMemo(() => detectFileSystemCapabilities(), []);

  const {
    activeTrackId,
    isPlaying,
    positions,
    normalizedByTrack,
    togglePlay,
    toggleNormalizePreview,
    seekTrack,
  } = useAudioPreview(tracks, settings);

  const revokeTrackArtwork = (track: TrackItem) => {
    if (track.metadata?.artwork?.objectUrl) {
      URL.revokeObjectURL(track.metadata.artwork.objectUrl);
    }
  };

  useEffect(() => {
    return () => {
      if (decodeCtxRef.current) {
        void decodeCtxRef.current.close();
      }
    };
  }, []);

  const ingestPickedFiles = useCallback(async (pickedList: PickedAudioFile[]) => {
    const supported = pickedList.filter(({ file }) => isSupportedAudioFile(file));
    const skippedCount = pickedList.length - supported.length;

    if (skippedCount > 0) {
      setPickerNotice(
        `Skipped ${skippedCount} unsupported file${skippedCount === 1 ? '' : 's'}. Supported audio: MP3, M4A, AAC, WAV, OGG, FLAC.`
      );
    } else {
      setPickerNotice(null);
    }

    if (supported.length === 0) return;

    const initialItems: TrackItem[] = supported.map(
      ({ file, fileHandle, parentDirHandle }, idx) => ({
        id: makeTrackId(file.name, file.size, idx),
        file,
        fileName: file.name,
        fileSizeBytes: file.size,
        format: detectContainerFormat(file.name, file.type),
        fileHandle,
        parentDirHandle,
        selected: true,
        status: 'analyzing',
        metadata: null,
        analysis: null,
        manualGainOverrideDb: null,
      })
    );

    setTracks((prev) => [...prev, ...initialItems]);

    if (!decodeCtxRef.current) {
      decodeCtxRef.current = new AudioContext();
    }
    const ctx = decodeCtxRef.current;

    for (const item of initialItems) {
      try {
        const arrayBuf = await item.file.arrayBuffer();
        const rawBytes = new Uint8Array(arrayBuf);

        let metadata = parseId3AndMetadata(rawBytes, item.fileName);
        let mp3Info:
          | { detectedBitrateKbps: number | null; isVbr: boolean; hasCrc: boolean }
          | undefined;

        if (item.format === 'mp3') {
          const streamScan = scanMp3AudioStream(
            rawBytes,
            metadata.audioStartOffset,
            metadata.audioEndOffset
          );
          mp3Info = {
            detectedBitrateKbps: streamScan.detectedBitrateKbps,
            isVbr: streamScan.isVbr,
            hasCrc: streamScan.hasCrc,
          };
        } else {
          metadata = {
            ...metadata,
            hasId3v2: false,
            id3v2Version: null,
            id3v2ByteLength: 0,
            hasId3v1: false,
            tailByteLength: 0,
            rawHeaderBytes: new Uint8Array(0),
            rawTailBytes: new Uint8Array(0),
          };
        }

        // arrayBuf is no longer needed after metadata/MP3 scan; let decodeAudioData consume it directly
        const audioBuf = await ctx.decodeAudioData(arrayBuf);
        const { metrics } = analyzeAudioBuffer(audioBuf, mp3Info);

        // Store lightweight metadata & analysis metrics; decode PCM on-demand for preview/export
        setTracks((prev) =>
          prev.map((t) =>
            t.id === item.id
              ? {
                  ...t,
                  status: 'ready',
                  metadata,
                  analysis: metrics,
                }
              : t
          )
        );
      } catch (err) {
        setTracks((prev) =>
          prev.map((t) =>
            t.id === item.id
              ? {
                  ...t,
                  status: 'error',
                  selected: false,
                  errorMessage:
                    err instanceof Error
                      ? `Could not decode audio: ${err.message}`
                      : 'Failed to decode audio file.',
                }
              : t
          )
        );
      }
      // Yield briefly so UI remains smooth across large multi-file batches
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }, []);

  const handleAddFilesClick = async () => {
    if (!fsCaps.canReplaceOriginalsDirectly) {
      // Synchronous click preserves browser user-gesture activation
      fileInputRef.current?.click();
      return;
    }
    try {
      const { files, blockedBySecurity } = await pickFilesWithHandles();
      if (!blockedBySecurity) {
        if (files.length > 0) await ingestPickedFiles(files);
        return;
      }
      setPickerNotice(
        'Native folder-write picker was blocked by browser permissions. Using standard multi-file selector instead.'
      );
    } catch {
      // Fall through below
    }
    fileInputRef.current?.click();
  };

  const handlePickFolder = async () => {
    try {
      const { files, blockedBySecurity } = await pickFolderWithHandles();
      if (blockedBySecurity) {
        fileInputRef.current?.click();
        return;
      }
      if (files.length > 0) {
        await ingestPickedFiles(files);
      } else {
        setPickerNotice('No supported audio files (MP3, M4A, AAC, WAV) were found in that folder.');
      }
    } catch {
      fileInputRef.current?.click();
    }
  };

  const handleFileInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    const fileList = Array.from(input.files ?? []);
    try {
      if (fileList.length > 0) {
        await ingestPickedFiles(fileList.map((file) => ({ file })));
      }
    } finally {
      input.value = '';
    }
  };

  const handleDropFiles = async (dt: DataTransfer) => {
    const picked = await extractDroppedAudioFiles(dt);
    if (picked.length > 0) {
      await ingestPickedFiles(picked);
    }
  };

  const handleToggleSelect = (id: string) => {
    setTracks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, selected: !t.selected } : t))
    );
  };

  const handleToggleSelectAll = () => {
    const selectable = tracks.filter(
      (t) => t.status === 'ready' || t.status === 'done'
    );
    const allSelected =
      selectable.length > 0 && selectable.every((t) => t.selected);
    setTracks((prev) =>
      prev.map((t) =>
        t.status === 'ready' || t.status === 'done'
          ? { ...t, selected: !allSelected }
          : t
      )
    );
  };

  const handleChangeManualGain = (id: string, gainDb: number | null) => {
    setTracks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, manualGainOverrideDb: gainDb } : t))
    );
  };

  const handleResetOverrides = () => {
    setTracks((prev) => prev.map((t) => ({ ...t, manualGainOverrideDb: null })));
  };

  const handleRemoveTrack = (id: string) => {
    if (inspectedTrackId === id) {
      setInspectedTrackId(null);
    }
    setTracks((prev) => {
      const target = prev.find((t) => t.id === id);
      if (target) revokeTrackArtwork(target);
      return prev.filter((t) => t.id !== id);
    });
  };

  const handleClearAll = () => {
    setInspectedTrackId(null);
    setTracks((prev) => {
      prev.forEach(revokeTrackArtwork);
      return [];
    });
  };

  const handleTrackExported = (
    id: string,
    result: NonNullable<TrackItem['exportResult']>
  ) => {
    setTracks((prev) =>
      prev.map((t) =>
        t.id === id ? { ...t, status: 'done', exportResult: result } : t
      )
    );
  };

  const selectedCount = tracks.filter(
    (t) => t.selected && (t.status === 'ready' || t.status === 'done')
  ).length;
  const overriddenCount = tracks.filter(
    (t) => t.manualGainOverrideDb !== null
  ).length;
  const hasNonMp3 = tracks.some((t) => t.format !== 'mp3');

  const inspectedTrack = tracks.find((t) => t.id === inspectedTrackId) ?? null;

  return (
    <div className="min-h-screen flex flex-col bg-[#0b0f17] text-slate-100">
      <input
        id="audio-file-input"
        ref={fileInputRef}
        type="file"
        multiple
        accept=".mp3,.m4a,.aac,.wav,.ogg,.flac,audio/*"
        onChange={handleFileInputChange}
        className="hidden"
      />

      <Header
        activeSection={activeSection}
        selectedCount={selectedCount}
        onNavigate={setActiveSection}
        onOpenExport={() => setIsExportOpen(true)}
      />

      <main className="flex-1 max-w-[1400px] w-full mx-auto px-6 py-7 space-y-6 pb-16">
        {activeSection === 'workspace' && (
          <>
            {/* Intro Title */}
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div className="space-y-1 max-w-2xl">
                <h1 className="font-display text-2xl font-bold tracking-tight text-white">
                  Local Batch Volume Normalizer
                </h1>
                <p className="text-sm text-slate-400">
                  Inspect each track’s full-song volume bars, audition Original vs. Normalized live with seeking, fine-tune gain, and preserve ID3 tags, lyrics, and cover art untouched.
                </p>
              </div>
              <div className="text-xs text-slate-500">
                100% client-side processing · Zero server uploads
              </div>
            </div>

            {/* ONLY ONE File Input Box on the entire page, right at the top */}
            <section
              aria-label="Audio File Input"
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (!isDraggingTop) setIsDraggingTop(true);
              }}
              onDragLeave={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setIsDraggingTop(false);
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setIsDraggingTop(false);
                if (e.dataTransfer) void handleDropFiles(e.dataTransfer);
              }}
              className={`bg-[#111827] border-2 border-dashed rounded-xl px-6 py-5 flex flex-wrap items-center justify-between gap-4 transition-colors ${
                isDraggingTop
                  ? 'border-blue-500 bg-blue-950/30'
                  : 'border-slate-700 hover:border-slate-600'
              }`}
            >
              <div className="flex items-center gap-4 min-w-0">
                <div className="w-10 h-10 rounded-lg bg-slate-900 border border-slate-800 flex items-center justify-center shrink-0 text-slate-300">
                  <Upload className="w-5 h-5" aria-hidden="true" />
                </div>
                <div className="min-w-0">
                  <div className="font-display text-sm font-semibold text-white">
                    Drop audio files here or select from your device
                  </div>
                  <p className="text-xs text-slate-400 mt-0.5">
                    MP3 native processing (ID3v2, lyrics &amp; cover art untouched) · M4A &amp; AAC analyzed &amp; previewed locally
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2.5 shrink-0">
                {fsCaps.canReplaceOriginalsDirectly && (
                  <button
                    type="button"
                    onClick={handlePickFolder}
                    className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-slate-200 bg-slate-900 border border-slate-700 hover:border-slate-600 hover:bg-slate-800 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
                  >
                    <FolderOpen className="w-4 h-4 text-slate-400" aria-hidden="true" />
                    <span>Open Folder</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleAddFilesClick}
                  className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-white bg-blue-600 hover:bg-blue-500 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
                >
                  <Upload className="w-4 h-4" aria-hidden="true" />
                  <span>Select Audio Files</span>
                </button>
              </div>
            </section>

            {pickerNotice && (
              <div className="bg-amber-950/40 border border-amber-800/60 rounded-xl px-4 py-3 flex items-center justify-between gap-3 text-xs text-amber-200">
                <div className="flex items-center gap-2.5">
                  <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" aria-hidden="true" />
                  <span>{pickerNotice}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setPickerNotice(null)}
                  className="text-amber-300 hover:text-amber-100 font-medium cursor-pointer shrink-0"
                >
                  Dismiss
                </button>
              </div>
            )}

            {/* Honest Environment / Format Notices */}
            {fsCaps.isEmbeddedIframe && (
              <div className="bg-[#111827] border border-slate-800 rounded-xl px-4 py-3 flex items-start gap-3 text-xs text-slate-300">
                <Info className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" aria-hidden="true" />
                <div>
                  <span className="font-semibold text-white">
                    Embedded frame mode:
                  </span>{' '}
                  Browser security blocks direct in-place overwriting of files on disk inside an embedded frame. You can process and download tracks with the{' '}
                  <span className="font-mono text-white">_norm</span> filename suffix (individually or as a ZIP), or open the app in a standalone Chrome/Edge tab to enable direct file replacement.
                </div>
              </div>
            )}

            {hasNonMp3 && (
              <div className="bg-amber-950/40 border border-amber-800/60 rounded-xl px-4 py-3 flex items-start gap-3 text-xs text-amber-200">
                <AlertCircle
                  className="w-4 h-4 text-amber-400 shrink-0 mt-0.5"
                  aria-hidden="true"
                />
                <div>
                  <span className="font-semibold text-amber-100">M4A / AAC format notice:</span>{' '}
                  Because the fast native MP3 engine runs without downloading FFmpeg WebAssembly, non-MP3 files are decoded locally for loudness analysis and A/B preview, and exported as normalized 320 kbps MP3 files (without source MP4 atoms).
                </div>
              </div>
            )}

            {/* Global Target & Processing Engine Rack */}
            <ControlRack
              settings={settings}
              onChangeSettings={setSettings}
              tracks={tracks}
              selectedCount={selectedCount}
              overriddenCount={overriddenCount}
              onResetOverrides={handleResetOverrides}
            />

            {/* Per-File Complete Cards + Seekable Volume Bar Players */}
            <TrackList
              tracks={tracks}
              settings={settings}
              activeTrackId={activeTrackId}
              isPlaying={isPlaying}
              positions={positions}
              normalizedByTrack={normalizedByTrack}
              onToggleSelect={handleToggleSelect}
              onToggleSelectAll={handleToggleSelectAll}
              onChangeManualGain={handleChangeManualGain}
              onRemoveTrack={handleRemoveTrack}
              onClearAll={handleClearAll}
              onTogglePlay={togglePlay}
              onTogglePreviewMode={toggleNormalizePreview}
              onSeekTrack={seekTrack}
              onInspectTrack={(t) => setInspectedTrackId(t.id)}
            />

            {/* Bottom Key to Apply Changes and Save Files */}
            <section
              aria-label="Apply Normalization and Save Files"
              className="bg-[#111827] border border-slate-800 rounded-xl px-6 py-5 flex flex-wrap items-center justify-between gap-4"
            >
              <div className="space-y-0.5">
                <div className="font-display text-base font-semibold text-white">
                  Ready to Apply &amp; Save Batch
                </div>
                <p className="text-xs text-slate-400">
                  {selectedCount === 0
                    ? 'Select at least one track above to apply normalization.'
                    : `${selectedCount} track${selectedCount === 1 ? '' : 's'} selected · ${
                        settings.targetMode === 'peak'
                          ? `Target ${settings.targetPeakDb.toFixed(1)} dBTP`
                          : `Target ${settings.targetLufs.toFixed(1)} LUFS`
                      } · ${
                        settings.engineMode === 'lossless'
                          ? 'Lossless 1.5 dB Header Patch'
                          : 'Exact 0.1 dB Re-encode'
                      } · Choose your output folder ("music_normalized") or replace originals next.`}
                </p>
              </div>

              <button
                type="button"
                disabled={selectedCount === 0}
                onClick={() => setIsExportOpen(true)}
                className="inline-flex items-center gap-2.5 px-6 py-3 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-500 disabled:bg-slate-800 disabled:text-slate-500 disabled:cursor-not-allowed rounded-lg transition-colors whitespace-nowrap cursor-pointer"
              >
                <Download className="w-4 h-4" aria-hidden="true" />
                <span>Apply Changes &amp; Save Files ({selectedCount})</span>
              </button>
            </section>
          </>
        )}

        {activeSection === 'engine' && (
          <section className="space-y-6">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h1 className="font-display text-2xl font-bold tracking-tight text-white">
                  Audio Engine &amp; Distortion Prevention
                </h1>
                <p className="text-sm text-slate-400 mt-1">
                  How GainBench measures loudness and raises volume without clipping or acoustic distortion.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setActiveSection('workspace')}
                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-500 rounded-lg cursor-pointer whitespace-nowrap"
              >
                Back to Batch Queue
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
              <div className="bg-[#111827] border border-slate-800 rounded-xl p-6 space-y-2.5">
                <Sliders className="w-5 h-5 text-blue-400" aria-hidden="true" />
                <h2 className="font-display text-base font-semibold text-white">
                  4x True Peak &amp; BS.1770-4 LUFS
                </h2>
                <p className="text-sm text-slate-400 leading-relaxed">
                  Tracks are scanned using Catmull-Rom 4x oversampled inter-sample peak detection and ITU-R BS.1770-4 K-weighted loudness gating (-70 LUFS absolute / -10 LU relative) so every headroom reading reflects real DAC behavior.
                </p>
              </div>

              <div className="bg-[#111827] border border-slate-800 rounded-xl p-6 space-y-2.5">
                <CheckCircle2 className="w-5 h-5 text-emerald-400" aria-hidden="true" />
                <h2 className="font-display text-base font-semibold text-white">
                  Exact 0.1 dB + Lookahead Limiter
                </h2>
                <p className="text-sm text-slate-400 leading-relaxed">
                  Decodes locally via Web Audio API, applies exact 0.1 dB gain, protects transients with an O(N) 5 ms lookahead brickwall limiter (65 ms smooth release) so peaks never clip above your ceiling, and re-encodes via LAME MP3.
                </p>
              </div>

              <div className="bg-[#111827] border border-slate-800 rounded-xl p-6 space-y-2.5">
                <ShieldCheck className="w-5 h-5 text-slate-300" aria-hidden="true" />
                <h2 className="font-display text-base font-semibold text-white">
                  Lossless 1.5 dB MP3 Header Patch
                </h2>
                <p className="text-sm text-slate-400 leading-relaxed">
                  Modifies the 8-bit <span className="font-mono text-xs text-slate-200">global_gain</span> field inside each MPEG-1/2 Layer III granule directly in 1.505 dB steps and updates frame CRC-16 checksums without decoding or re-encoding the audio stream.
                </p>
              </div>
            </div>
          </section>
        )}

        {activeSection === 'preservation' && (
          <section className="space-y-6">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h1 className="font-display text-2xl font-bold tracking-tight text-white">
                  ID3 Tag, Lyrics &amp; Artwork Integrity
                </h1>
                <p className="text-sm text-slate-400 mt-1">
                  Every MP3 file’s original ID3v2 header and ID3v1/APEv2 tail are sliced out as raw binary blocks and restored byte-for-byte untouched.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setActiveSection('workspace')}
                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-500 rounded-lg cursor-pointer whitespace-nowrap"
              >
                Back to Batch Queue
              </button>
            </div>

            <div className="bg-[#111827] border border-slate-800 rounded-xl overflow-hidden">
              <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between">
                <h2 className="font-display text-sm font-semibold text-white">
                  Loaded MP3 Metadata Audit ({tracks.filter((t) => t.format === 'mp3').length} files)
                </h2>
              </div>

              {tracks.filter((t) => t.format === 'mp3').length === 0 ? (
                <div className="p-10 text-center text-sm text-slate-400">
                  Add MP3 files in the Batch Queue to verify their exact ID3v2 header bytes, cover art, and lyrics frames.
                </div>
              ) : (
                <div className="divide-y divide-slate-800">
                  {tracks
                    .filter((t) => t.format === 'mp3')
                    .map((t) => (
                      <div
                        key={t.id}
                        className="px-6 py-4 flex flex-wrap items-center justify-between gap-4 text-xs"
                      >
                        <div className="min-w-0">
                          <div className="font-medium text-sm text-white truncate">
                            {t.metadata?.title || t.fileName}
                          </div>
                          <div className="text-slate-400 font-mono tabular-nums mt-0.5">
                            {t.metadata?.id3v2Version ?? 'No ID3v2'} · Header:{' '}
                            {(t.metadata?.id3v2ByteLength ?? 0).toLocaleString()} bytes · Tail:{' '}
                            {(t.metadata?.tailByteLength ?? 0).toLocaleString()} bytes
                          </div>
                        </div>

                        <div className="flex items-center gap-4">
                          <span className="text-slate-300">
                            {t.metadata?.artwork
                              ? `Cover Art (${(t.metadata.artwork.byteLength / 1024).toFixed(1)} KB)`
                              : 'No Art'}
                            {' · '}
                            {t.metadata?.lyrics
                              ? `Lyrics (${t.metadata.lyrics.text.split('\n').length} lines)`
                              : 'No Lyrics'}
                          </span>
                          <button
                            type="button"
                            onClick={() => setInspectedTrackId(t.id)}
                            className="px-3 py-1.5 font-medium text-blue-400 hover:text-blue-300 border border-slate-700 rounded-lg hover:bg-slate-800 cursor-pointer"
                          >
                            Inspect
                          </button>
                        </div>
                      </div>
                    ))}
                </div>
              )}
            </div>
          </section>
        )}
      </main>

      <MetadataInspector
        track={inspectedTrack}
        onClose={() => setInspectedTrackId(null)}
      />

      <ExportModal
        isOpen={isExportOpen}
        tracks={tracks}
        settings={settings}
        fsCaps={fsCaps}
        onClose={() => setIsExportOpen(false)}
        onTrackExported={handleTrackExported}
      />
    </div>
  );
}
