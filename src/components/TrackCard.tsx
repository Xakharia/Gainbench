import React from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  Minus,
  Music,
  Plus,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { computeTrackGain, LOSSLESS_STEP_DB } from '../audio/loudnessAnalyzer';
import type { NormalizationSettings, TrackItem } from '../types/audio';
import { VolumeBarPlayer } from './VolumeBarPlayer';

interface TrackCardProps {
  track: TrackItem;
  settings: NormalizationSettings;
  isPlaying: boolean;
  currentTime: number;
  previewNormalized: boolean;
  onToggleSelect: (id: string) => void;
  onChangeManualGain: (id: string, gainDb: number | null) => void;
  onRemoveTrack: (id: string) => void;
  onInspectTrack: (track: TrackItem) => void;
  onTogglePlay: () => void;
  onTogglePreviewMode: () => void;
  onSeek: (timeSeconds: number) => void;
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export const TrackCard: React.FC<TrackCardProps> = ({
  track,
  settings,
  isPlaying,
  currentTime,
  previewNormalized,
  onToggleSelect,
  onChangeManualGain,
  onRemoveTrack,
  onInspectTrack,
  onTogglePlay,
  onTogglePreviewMode,
  onSeek,
}) => {
  const isAnalyzing = track.status === 'analyzing';
  const isError = track.status === 'error';
  const analysis = track.analysis;
  const meta = track.metadata;

  const computed = analysis
    ? computeTrackGain(
        analysis,
        settings,
        track.manualGainOverrideDb,
        track.format === 'mp3'
      )
    : null;

  const sliderMin = -18.0;
  const sliderMax = 24.0;
  const sliderStep =
    settings.engineMode === 'lossless' && track.format === 'mp3'
      ? Number(LOSSLESS_STEP_DB.toFixed(2))
      : 0.1;

  const effectiveGainValue =
    track.manualGainOverrideDb !== null
      ? track.manualGainOverrideDb
      : computed?.appliedGainDb ?? 0;

  return (
    <article
      className={`bg-[#111827] border rounded-xl p-5 space-y-4 transition-colors ${
        track.selected
          ? 'border-slate-800'
          : 'border-slate-800/70 opacity-65'
      }`}
    >
      {/* Top Header: Checkbox + Cover Art + One-Item-Per-Line ID3 & File Info + Actions */}
      <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
        <div className="flex items-start gap-4 min-w-0 flex-1">
          <input
            type="checkbox"
            checked={track.selected}
            disabled={isAnalyzing || isError}
            onChange={() => onToggleSelect(track.id)}
            aria-label={`Include ${track.fileName} in batch`}
            className="mt-1 w-4 h-4 rounded border-slate-700 bg-slate-950 text-blue-500 focus:ring-blue-500 cursor-pointer disabled:opacity-40 shrink-0"
          />

          <div className="w-20 h-20 rounded-lg border border-slate-800 bg-slate-950 shrink-0 overflow-hidden flex items-center justify-center">
            {meta?.artwork ? (
              <img
                src={meta.artwork.objectUrl}
                alt={`Cover for ${meta.title || track.fileName}`}
                referrerPolicy="no-referrer"
                className="w-full h-full object-cover"
              />
            ) : (
              <Music className="w-7 h-7 text-slate-600" aria-hidden="true" />
            )}
          </div>

          {/* Dedicated single-line rows for each piece of ID3 tag and file info */}
          <div className="min-w-0 flex-1 space-y-1">
            <h3 className="font-display text-base font-semibold text-white truncate">
              {meta?.title || track.fileName}
            </h3>

            {isAnalyzing ? (
              <p className="text-xs text-slate-400">
                Decoding audio and scanning ID3v2 / LUFS...
              </p>
            ) : isError ? (
              <p className="text-xs text-red-400">{track.errorMessage}</p>
            ) : (
              <dl className="grid grid-cols-1 gap-y-1 text-xs pt-1">
                <div className="flex items-center gap-2 min-w-0">
                  <dt className="text-slate-500 shrink-0 w-16">Artist</dt>
                  <dd className="text-slate-200 truncate">
                    {meta?.artist || '—'}
                  </dd>
                </div>

                <div className="flex items-center gap-2 min-w-0">
                  <dt className="text-slate-500 shrink-0 w-16">Album</dt>
                  <dd className="text-slate-200 truncate">
                    {meta?.album
                      ? `${meta.album}${meta.year ? ` (${meta.year})` : ''}`
                      : meta?.year || '—'}
                  </dd>
                </div>

                <div className="flex items-center gap-2 min-w-0">
                  <dt className="text-slate-500 shrink-0 w-16">File</dt>
                  <dd className="text-slate-300 font-mono truncate">
                    {track.fileName}
                  </dd>
                </div>

                <div className="flex items-center gap-2 min-w-0">
                  <dt className="text-slate-500 shrink-0 w-16">Audio</dt>
                  <dd className="text-slate-300 font-mono tabular-nums truncate">
                    {track.format.toUpperCase()}
                    {analysis?.detectedBitrateKbps
                      ? ` · ${analysis.detectedBitrateKbps} kbps`
                      : ''}
                    {analysis
                      ? ` · ${formatDuration(analysis.durationSeconds)}`
                      : ''}
                    {` · ${formatFileSize(track.fileSizeBytes)}`}
                  </dd>
                </div>

                <div className="flex items-center gap-2 min-w-0">
                  <dt className="text-slate-500 shrink-0 w-16">ID3 Tag</dt>
                  <dd className="text-slate-300 font-mono truncate">
                    {track.format === 'mp3'
                      ? meta?.hasId3v2
                        ? `${meta.id3v2Version} (${meta.id3v2ByteLength.toLocaleString()} B)`
                        : meta?.hasId3v1
                          ? 'ID3v1 (128 B)'
                          : 'No ID3 tag'
                      : 'Exports as 320k MP3'}
                  </dd>
                </div>

                <div className="flex items-center gap-2 min-w-0">
                  <dt className="text-slate-500 shrink-0 w-16">Artwork</dt>
                  <dd className="text-slate-300 truncate">
                    {meta?.artwork
                      ? `${meta.artwork.mimeType} (${(meta.artwork.byteLength / 1024).toFixed(0)} KB)`
                      : 'None'}
                  </dd>
                </div>

                <div className="flex items-center gap-2 min-w-0">
                  <dt className="text-slate-500 shrink-0 w-16">Lyrics</dt>
                  <dd className="text-slate-300 truncate">
                    {meta?.lyrics
                      ? `Embedded (${meta.lyrics.text.split('\n').length} lines)`
                      : 'None'}
                  </dd>
                </div>
              </dl>
            )}
          </div>
        </div>

        {/* Status & Menu Buttons */}
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {computed && (
            <span className="text-xs font-medium mr-1 inline-flex items-center gap-1.5">
              {computed.wouldClip ? (
                <span className="text-red-400 inline-flex items-center gap-1">
                  <AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Clips (+{computed.projectedTruePeakDb.toFixed(1)} dB)</span>
                </span>
              ) : computed.limitingRequiredDb > 0.05 ? (
                <span className="text-amber-400 inline-flex items-center gap-1">
                  <AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Limiter -{computed.limitingRequiredDb.toFixed(1)} dB</span>
                </span>
              ) : track.exportResult ? (
                <span className="text-emerald-400 inline-flex items-center gap-1">
                  <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>
                    {track.exportResult.actionTaken === 'saved_to_music_normalized'
                      ? `Saved to music_normalized (${track.exportResult.outputFileName})`
                      : `Saved (${track.exportResult.outputFileName})`}
                  </span>
                </span>
              ) : (
                <span className="text-emerald-400 inline-flex items-center gap-1">
                  <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>{track.selected ? 'Set to Go' : 'Excluded'}</span>
                </span>
              )}
            </span>
          )}

          <button
            type="button"
            disabled={!meta}
            onClick={() => onInspectTrack(track)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-200 bg-slate-950 border border-slate-800 hover:border-slate-700 hover:bg-slate-800 rounded-lg transition-colors cursor-pointer disabled:opacity-40 whitespace-nowrap"
          >
            <Eye className="w-3.5 h-3.5 text-slate-400" aria-hidden="true" />
            <span>Check ID3 &amp; Lyrics</span>
          </button>

          <button
            type="button"
            onClick={() => onRemoveTrack(track.id)}
            aria-label={`Remove ${track.fileName}`}
            title="Remove file"
            className="p-2 text-slate-400 hover:text-red-400 hover:bg-red-950/50 rounded-lg transition-colors cursor-pointer"
          >
            <Trash2 className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Middle Row: Complete Per-File Analysis & Gain Menu */}
      {isAnalyzing ? (
        <div className="h-20 bg-slate-950/70 border border-slate-800 rounded-lg animate-pulse" />
      ) : analysis && computed ? (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 py-3 px-4 bg-slate-950/70 border border-slate-800 rounded-lg">
            {/* Current Volume */}
            <div>
              <div className="text-xs text-slate-400">Current Volume</div>
              <div className="font-mono text-sm font-semibold text-white tabular-nums mt-0.5">
                {analysis.truePeakDb.toFixed(1)} dBTP
              </div>
              <div className="font-mono text-xs text-slate-400 tabular-nums">
                {analysis.integratedLufs.toFixed(1)} LUFS
              </div>
            </div>

            {/* Max Possibility */}
            <div>
              <div className="text-xs text-slate-400">Max Possibility</div>
              <div
                className={`font-mono text-sm font-semibold tabular-nums mt-0.5 ${
                  analysis.maxSafeGainDb > 0.5
                    ? 'text-emerald-400'
                    : analysis.maxSafeGainDb >= -0.05
                      ? 'text-slate-200'
                      : 'text-red-400'
                }`}
              >
                {analysis.maxSafeGainDb >= 0 ? '+' : ''}
                {analysis.maxSafeGainDb.toFixed(1)} dB
              </div>
              <div className="text-xs text-slate-500">clean headroom</div>
            </div>

            {/* Individual Gain Control */}
            <div className="col-span-2 md:col-span-1">
              <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
                <span>Gain Adjust</span>
                {track.manualGainOverrideDb !== null && (
                  <button
                    type="button"
                    onClick={() => onChangeManualGain(track.id, null)}
                    className="inline-flex items-center gap-1 text-blue-400 hover:text-blue-300 font-medium cursor-pointer"
                  >
                    <RotateCcw className="w-3 h-3" aria-hidden="true" />
                    <span>Auto</span>
                  </button>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  aria-label={`Decrease gain for ${track.fileName}`}
                  onClick={() => {
                    const step =
                      settings.engineMode === 'lossless' && track.format === 'mp3'
                        ? LOSSLESS_STEP_DB
                        : 0.5;
                    onChangeManualGain(
                      track.id,
                      Math.max(
                        sliderMin,
                        Math.round((effectiveGainValue - step) * 10) / 10
                      )
                    );
                  }}
                  className="w-6 h-6 inline-flex items-center justify-center rounded border border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800 cursor-pointer shrink-0"
                >
                  <Minus className="w-3 h-3" aria-hidden="true" />
                </button>

                <input
                  type="range"
                  min={sliderMin}
                  max={sliderMax}
                  step={sliderStep}
                  value={Math.max(sliderMin, Math.min(sliderMax, effectiveGainValue))}
                  onChange={(e) =>
                    onChangeManualGain(track.id, parseFloat(e.target.value))
                  }
                  aria-label={`Individual gain dB for ${track.fileName}`}
                  className="flex-1 min-w-[70px] studio-slider"
                />

                <button
                  type="button"
                  aria-label={`Increase gain for ${track.fileName}`}
                  onClick={() => {
                    const step =
                      settings.engineMode === 'lossless' && track.format === 'mp3'
                        ? LOSSLESS_STEP_DB
                        : 0.5;
                    onChangeManualGain(
                      track.id,
                      Math.min(
                        sliderMax,
                        Math.round((effectiveGainValue + step) * 10) / 10
                      )
                    );
                  }}
                  className="w-6 h-6 inline-flex items-center justify-center rounded border border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800 cursor-pointer shrink-0"
                >
                  <Plus className="w-3 h-3" aria-hidden="true" />
                </button>

                <span className="font-mono text-xs font-semibold text-white tabular-nums w-14 text-right shrink-0">
                  {computed.appliedGainDb >= 0 ? '+' : ''}
                  {computed.appliedGainDb.toFixed(1)}dB
                </span>
              </div>
            </div>

            {/* Projected Output */}
            <div className="md:text-right">
              <div className="text-xs text-slate-400">Projected Output</div>
              <div className="font-mono text-sm font-semibold text-white tabular-nums mt-0.5">
                {computed.projectedTruePeakDb.toFixed(1)} dBTP
              </div>
              <div className="font-mono text-xs text-slate-400 tabular-nums">
                {computed.projectedLufs.toFixed(1)} LUFS
              </div>
            </div>
          </div>

          {/* Per-File Interactive Volume Bar Preview Player */}
          <VolumeBarPlayer
            track={track}
            computed={computed}
            settings={settings}
            isPlaying={isPlaying}
            currentTime={currentTime}
            previewNormalized={previewNormalized}
            onTogglePlay={onTogglePlay}
            onTogglePreviewMode={onTogglePreviewMode}
            onSeek={onSeek}
          />
        </>
      ) : null}
    </article>
  );
};
