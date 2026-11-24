import React, { useEffect, useRef } from 'react';
import { Pause, Play } from 'lucide-react';
import type {
  ComputedTrackGain,
  NormalizationSettings,
  TrackItem,
} from '../types/audio';

interface VolumeBarPlayerProps {
  track: TrackItem;
  computed: ComputedTrackGain;
  settings: NormalizationSettings;
  isPlaying: boolean;
  currentTime: number;
  previewNormalized: boolean;
  onTogglePlay: () => void;
  onTogglePreviewMode: () => void;
  onSeek: (timeSeconds: number) => void;
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export const VolumeBarPlayer: React.FC<VolumeBarPlayerProps> = ({
  track,
  computed,
  settings,
  isPlaying,
  currentTime,
  previewNormalized,
  onTogglePlay,
  onTogglePreviewMode,
  onSeek,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const isSeekingRef = useRef(false);

  const analysis = track.analysis;
  const duration = analysis?.durationSeconds ?? 0;

  const ceilingDb =
    settings.targetMode === 'peak'
      ? settings.targetPeakDb
      : settings.lufsPeakCeilingDb;

  // Compute live status message explaining if normalized or can still increase
  let statusText = '';
  let statusTone: 'neutral' | 'headroom' | 'max' | 'clip' = 'neutral';

  if (analysis) {
    if (!previewNormalized) {
      if (analysis.maxSafeGainDb > 0.5) {
        statusText = `Original · Can increase +${analysis.maxSafeGainDb.toFixed(1)} dB before max`;
        statusTone = 'headroom';
      } else {
        statusText = 'Original · Already at max volume';
        statusTone = 'max';
      }
    } else {
      if (computed.wouldClip) {
        statusText = `Normalized · Exceeds 0.0 dBTP (+${computed.projectedTruePeakDb.toFixed(1)} dB clipping)`;
        statusTone = 'clip';
      } else if (computed.limitingRequiredDb > 0.05) {
        statusText = `Normalized · Max ceiling (${ceilingDb.toFixed(1)} dBTP, limiter -${computed.limitingRequiredDb.toFixed(1)} dB)`;
        statusTone = 'max';
      } else if (computed.projectedTruePeakDb >= -1.0) {
        statusText = `Normalized · At max safe level (${computed.projectedTruePeakDb.toFixed(1)} dBTP)`;
        statusTone = 'max';
      } else {
        const remaining = 0.0 - computed.projectedTruePeakDb;
        statusText = `Normalized · ${computed.projectedTruePeakDb.toFixed(1)} dBTP (+${remaining.toFixed(1)} dB room left)`;
        statusTone = 'headroom';
      }
    }
  }

  // Render full-song vertical volume bars (matching attached screenshot, with RED bars for max volume)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !analysis) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) return;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    // Pure dark canvas background matching studio bar graph
    ctx.fillStyle = '#070b12';
    ctx.fillRect(0, 0, width, height);

    const padX = 12;
    const padTop = 10;
    const padBottom = 10;
    const plotW = Math.max(40, width - padX * 2);
    const plotH = Math.max(24, height - padTop - padBottom);

    // Subtle 0 dB Max Reference line at top
    ctx.strokeStyle = 'rgba(239, 68, 68, 0.25)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(padX, padTop);
    ctx.lineTo(padX + plotW, padTop);
    ctx.stroke();
    ctx.setLineDash([]);

    const peaks = analysis.waveformPeaks;
    const n = peaks.length;
    const pitch = plotW / n;
    const barW = Math.max(2, Math.min(6, pitch * 0.52));
    const gainDb = previewNormalized ? computed.appliedGainDb : 0;
    const useLimiter =
      previewNormalized &&
      settings.engineMode === 'exact' &&
      settings.clipProtection === 'limiter';

    const progressRatio = duration > 0 ? currentTime / duration : 0;

    for (let i = 0; i < n; i++) {
      const rawLin = Math.max(1e-4, peaks[i]);
      let barDb = 20 * Math.log10(rawLin) + gainDb;
      if (useLimiter && barDb > ceilingDb) {
        barDb = ceilingDb;
      }

      // Map -45 dB..0 dB to [0.06..1.0] height
      const normHeight = Math.max(0.06, Math.min(1.0, (barDb + 45) / 45));
      const barH = Math.max(3, normHeight * plotH);
      const x = padX + i * pitch + (pitch - barW) / 2;
      const y = padTop + plotH - barH;

      const isMaxVolume = barDb >= -1.0;
      const isPlayed = i / n <= progressRatio;

      if (isMaxVolume) {
        // Max volume bars MUST be shown in RED
        ctx.fillStyle = barDb > 0.05 ? '#dc2626' : '#ef4444';
      } else if (isPlayed && (currentTime > 0 || isPlaying)) {
        ctx.fillStyle = '#ffffff';
      } else {
        ctx.fillStyle = '#cbd5e1';
      }

      const r = Math.min(barW / 2, 2);
      if (typeof ctx.roundRect === 'function') {
        ctx.beginPath();
        ctx.roundRect(x, y, barW, barH, [r, r, 0, 0]);
        ctx.fill();
      } else {
        ctx.fillRect(x, y, barW, barH);
      }
    }

    // Playhead cursor line
    if (currentTime > 0 || isPlaying) {
      const playX = padX + Math.max(0, Math.min(1, progressRatio)) * plotW;
      ctx.strokeStyle = '#3b82f6';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(playX, 4);
      ctx.lineTo(playX, height - 4);
      ctx.stroke();
    }
  }, [
    analysis,
    computed.appliedGainDb,
    ceilingDb,
    currentTime,
    duration,
    isPlaying,
    previewNormalized,
    settings.clipProtection,
    settings.engineMode,
  ]);

  const computeSeekFromEvent = (clientX: number, rect: DOMRect) => {
    const padX = 12;
    const plotW = Math.max(1, rect.width - padX * 2);
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left - padX) / plotW));
    onSeek(ratio * duration);
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!analysis || duration <= 0) return;
    isSeekingRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    computeSeekFromEvent(e.clientX, e.currentTarget.getBoundingClientRect());
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isSeekingRef.current || !analysis || duration <= 0) return;
    computeSeekFromEvent(e.clientX, e.currentTarget.getBoundingClientRect());
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (isSeekingRef.current) {
      isSeekingRef.current = false;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // Ignore
      }
    }
  };

  return (
    <div className="bg-[#070b12] border border-slate-800 rounded-lg p-3 space-y-2.5">
      {/* Player Controls Row */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={!analysis}
            onClick={onTogglePlay}
            aria-label={
              isPlaying ? `Pause ${track.fileName}` : `Play preview ${track.fileName}`
            }
            className="w-8 h-8 rounded-full bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 text-white flex items-center justify-center shrink-0 transition-colors cursor-pointer"
          >
            {isPlaying ? (
              <Pause className="w-3.5 h-3.5" aria-hidden="true" />
            ) : (
              <Play className="w-3.5 h-3.5 ml-0.5" aria-hidden="true" />
            )}
          </button>

          <span className="font-mono text-xs text-slate-300 tabular-nums">
            {formatTime(currentTime)} / {formatTime(duration)}
          </span>
        </div>

        {/* Status telling whether normalized or still has room to increase */}
        <div className="flex flex-wrap items-center gap-3">
          <span
            className={`text-xs font-medium ${
              statusTone === 'clip'
                ? 'text-red-400'
                : statusTone === 'max'
                  ? 'text-red-400'
                  : statusTone === 'headroom'
                    ? 'text-amber-300'
                    : 'text-slate-400'
            }`}
          >
            {statusText}
          </span>

          {/* Button selecting Normalized vs Original preview */}
          <button
            type="button"
            disabled={!analysis}
            onClick={onTogglePreviewMode}
            aria-pressed={previewNormalized}
            className={`px-3 py-1.5 text-xs font-medium rounded-md border transition-colors cursor-pointer whitespace-nowrap ${
              previewNormalized
                ? 'bg-blue-600 border-blue-500 text-white hover:bg-blue-500'
                : 'bg-slate-800 border-slate-700 text-slate-200 hover:bg-slate-700'
            }`}
          >
            {previewNormalized ? 'Preview: Normalized' : 'Preview: Original'}
          </button>
        </div>
      </div>

      {/* Seekable Full-Song Volume Bar Graph */}
      <div className="relative">
        <canvas
          ref={canvasRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          title="Click or drag anywhere on the bars to seek"
          className="w-full h-20 rounded cursor-pointer block touch-none"
        />
        <div className="flex items-center justify-between text-[11px] font-mono text-slate-500 mt-1 px-1">
          <span>0:00</span>
          <span className="flex items-center gap-3">
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-xs bg-slate-300 inline-block" />
              <span>Normal level</span>
            </span>
            <span className="inline-flex items-center gap-1.5 text-red-400">
              <span className="w-2 h-2 rounded-xs bg-red-500 inline-block" />
              <span>Max volume (-1.0 to 0.0 dB)</span>
            </span>
          </span>
          <span>{formatTime(duration)}</span>
        </div>
      </div>
    </div>
  );
};
