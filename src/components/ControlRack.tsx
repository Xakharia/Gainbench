import React from 'react';
import { RotateCcw } from 'lucide-react';
import type { NormalizationSettings, TrackItem } from '../types/audio';

interface ControlRackProps {
  settings: NormalizationSettings;
  onChangeSettings: (next: NormalizationSettings) => void;
  tracks: TrackItem[];
  selectedCount: number;
  overriddenCount: number;
  onResetOverrides: () => void;
}

export const ControlRack: React.FC<ControlRackProps> = ({
  settings,
  onChangeSettings,
  tracks,
  selectedCount,
  overriddenCount,
  onResetOverrides,
}) => {
  const readyTracks = tracks.filter((t) => t.status === 'ready' || t.status === 'done');
  const mp3Count = readyTracks.filter((t) => t.format === 'mp3').length;
  const nonMp3Count = readyTracks.length - mp3Count;
  const artCount = readyTracks.filter((t) => t.metadata?.artwork).length;
  const lyricsCount = readyTracks.filter((t) => t.metadata?.lyrics).length;

  const avgLufs =
    readyTracks.length > 0
      ? readyTracks.reduce((acc, t) => acc + (t.analysis?.integratedLufs ?? 0), 0) /
        readyTracks.length
      : null;

  return (
    <section
      aria-label="Target Decibel and Processing Controls"
      className="bg-[#111827] border border-slate-800 rounded-xl overflow-hidden"
    >
      <div className="grid grid-cols-1 lg:grid-cols-12 divide-y lg:divide-y-0 lg:divide-x divide-slate-800">
        {/* Column 1: Target Level Controls */}
        <div className="lg:col-span-4 p-5 flex flex-col justify-between gap-4">
          <div className="space-y-3.5">
            <div className="flex items-center justify-between gap-4">
              <h2 className="font-display text-sm font-semibold text-white">
                Target Level
              </h2>
              <div
                role="group"
                aria-label="Normalization target mode"
                className="inline-flex items-center p-0.5 bg-slate-950 border border-slate-800 rounded-lg"
              >
                <button
                  type="button"
                  onClick={() => onChangeSettings({ ...settings, targetMode: 'peak' })}
                  className={`px-3 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    settings.targetMode === 'peak'
                      ? 'bg-slate-800 text-white'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Peak (dBTP)
                </button>
                <button
                  type="button"
                  onClick={() => onChangeSettings({ ...settings, targetMode: 'lufs' })}
                  className={`px-3 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    settings.targetMode === 'lufs'
                      ? 'bg-slate-800 text-white'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Loudness (LUFS)
                </button>
              </div>
            </div>

            {settings.targetMode === 'peak' ? (
              <div className="space-y-2.5">
                <div className="flex items-baseline justify-between">
                  <label
                    htmlFor="target-peak-slider"
                    className="text-xs text-slate-400 font-medium"
                  >
                    Maximum True Peak Ceiling
                  </label>
                  <span className="font-mono text-base font-semibold text-white tabular-nums">
                    {settings.targetPeakDb > 0 ? '+' : ''}
                    {settings.targetPeakDb.toFixed(1)} dBTP
                  </span>
                </div>
                <input
                  id="target-peak-slider"
                  type="range"
                  min={-6.0}
                  max={0.0}
                  step={0.1}
                  value={settings.targetPeakDb}
                  onChange={(e) =>
                    onChangeSettings({
                      ...settings,
                      targetPeakDb: parseFloat(e.target.value),
                    })
                  }
                  className="w-full studio-slider"
                />
                <div className="flex items-center justify-between gap-2 pt-0.5">
                  {[-0.1, -0.5, -1.0, -2.0].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() =>
                        onChangeSettings({ ...settings, targetPeakDb: preset })
                      }
                      className={`flex-1 py-1.5 text-xs font-mono tabular-nums rounded-md border transition-colors cursor-pointer whitespace-nowrap ${
                        Math.abs(settings.targetPeakDb - preset) < 0.05
                          ? 'border-blue-500 bg-blue-600/20 text-blue-300 font-medium'
                          : 'border-slate-800 bg-slate-950/60 text-slate-400 hover:border-slate-700 hover:text-slate-200'
                      }`}
                    >
                      {preset.toFixed(1)} dB
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="space-y-2.5">
                <div className="flex items-baseline justify-between">
                  <label
                    htmlFor="target-lufs-slider"
                    className="text-xs text-slate-400 font-medium"
                  >
                    Target Integrated Loudness
                  </label>
                  <span className="font-mono text-base font-semibold text-white tabular-nums">
                    {settings.targetLufs.toFixed(1)} LUFS
                  </span>
                </div>
                <input
                  id="target-lufs-slider"
                  type="range"
                  min={-23.0}
                  max={-8.0}
                  step={0.5}
                  value={settings.targetLufs}
                  onChange={(e) =>
                    onChangeSettings({
                      ...settings,
                      targetLufs: parseFloat(e.target.value),
                    })
                  }
                  className="w-full studio-slider"
                />
                <div className="flex items-center justify-between gap-2 pt-0.5">
                  {[
                    { label: '-11 Club', val: -11.0 },
                    { label: '-14 Stream', val: -14.0 },
                    { label: '-16 Apple', val: -16.0 },
                    { label: '-23 EBU', val: -23.0 },
                  ].map((p) => (
                    <button
                      key={p.val}
                      type="button"
                      onClick={() =>
                        onChangeSettings({ ...settings, targetLufs: p.val })
                      }
                      className={`flex-1 py-1.5 px-1 text-xs rounded-md border transition-colors cursor-pointer whitespace-nowrap ${
                        Math.abs(settings.targetLufs - p.val) < 0.1
                          ? 'border-blue-500 bg-blue-600/20 text-blue-300 font-medium'
                          : 'border-slate-800 bg-slate-950/60 text-slate-400 hover:border-slate-700 hover:text-slate-200'
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <p className="text-xs text-slate-400 leading-relaxed">
            {settings.targetMode === 'peak'
              ? 'Raises each track cleanly to the peak ceiling without clipping or dynamic compression.'
              : 'Matches perceived loudness across tracks using ITU-R BS.1770-4 K-weighted gating.'}
          </p>
        </div>

        {/* Column 2: MP3 Engine & Distortion Guard */}
        <div className="lg:col-span-5 p-5 flex flex-col justify-between gap-4">
          <div className="space-y-3.5">
            <div className="flex items-center justify-between gap-3">
              <h2 className="font-display text-sm font-semibold text-white">
                MP3 Processing Engine
              </h2>
              <span className="text-xs text-slate-400 whitespace-nowrap">
                ID3v2 + Art + Lyrics Untouched
              </span>
            </div>

            <div
              role="group"
              aria-label="MP3 gain processing engine"
              className="grid grid-cols-2 p-1 bg-slate-950 border border-slate-800 rounded-lg gap-1"
            >
              <button
                type="button"
                onClick={() =>
                  onChangeSettings({ ...settings, engineMode: 'exact' })
                }
                className={`py-2 px-3 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                  settings.engineMode === 'exact'
                    ? 'bg-slate-800 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Exact 0.1 dB Re-encode
              </button>
              <button
                type="button"
                onClick={() =>
                  onChangeSettings({ ...settings, engineMode: 'lossless' })
                }
                className={`py-2 px-3 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                  settings.engineMode === 'lossless'
                    ? 'bg-slate-800 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Lossless 1.5 dB Header
              </button>
            </div>

            {settings.engineMode === 'exact' ? (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label
                    htmlFor="clip-protection-select"
                    className="block text-xs text-slate-400 font-medium mb-1"
                  >
                    Peak Protection
                  </label>
                  <select
                    id="clip-protection-select"
                    value={settings.clipProtection}
                    onChange={(e) =>
                      onChangeSettings({
                        ...settings,
                        clipProtection: e.target.value as NormalizationSettings['clipProtection'],
                      })
                    }
                    className="w-full h-9 px-2.5 text-xs bg-slate-950 border border-slate-800 rounded-lg text-slate-100 focus:outline-2 focus:outline-blue-500"
                  >
                    <option value="limiter">Lookahead Limiter</option>
                    <option value="clamp">Strict Peak Clamp</option>
                  </select>
                </div>

                <div>
                  <label
                    htmlFor="output-bitrate-select"
                    className="block text-xs text-slate-400 font-medium mb-1"
                  >
                    MP3 Bitrate
                  </label>
                  <select
                    id="output-bitrate-select"
                    value={settings.outputBitrate}
                    onChange={(e) => {
                      const v = e.target.value;
                      onChangeSettings({
                        ...settings,
                        outputBitrate: v === 'match' ? 'match' : (Number(v) as 320 | 256 | 192),
                      });
                    }}
                    className="w-full h-9 px-2.5 text-xs bg-slate-950 border border-slate-800 rounded-lg text-slate-100 focus:outline-2 focus:outline-blue-500"
                  >
                    <option value="match">Match Source Bitrate</option>
                    <option value={320}>320 kbps (Max)</option>
                    <option value={256}>256 kbps</option>
                    <option value={192}>192 kbps</option>
                  </select>
                </div>
              </div>
            ) : (
              <div className="bg-slate-950/70 border border-slate-800 rounded-lg p-3 text-xs text-slate-300 leading-relaxed">
                Patches MPEG Layer III <span className="font-mono text-white">global_gain</span> bytes in{' '}
                <span className="font-mono text-white">1.5 dB</span> steps with zero re-encoding. Automatically clamps below ceiling to prevent clipping.
              </div>
            )}

            {settings.targetMode === 'lufs' && (
              <div className="flex items-center justify-between pt-0.5">
                <label
                  htmlFor="lufs-ceiling-select"
                  className="text-xs text-slate-400 font-medium"
                >
                  True-Peak Safety Ceiling
                </label>
                <select
                  id="lufs-ceiling-select"
                  value={settings.lufsPeakCeilingDb}
                  onChange={(e) =>
                    onChangeSettings({
                      ...settings,
                      lufsPeakCeilingDb: parseFloat(e.target.value),
                    })
                  }
                  className="h-8 px-2.5 text-xs font-mono bg-slate-950 border border-slate-800 rounded-md text-slate-100 focus:outline-2 focus:outline-blue-500"
                >
                  <option value={-0.1}>-0.1 dBTP</option>
                  <option value={-0.5}>-0.5 dBTP</option>
                  <option value={-1.0}>-1.0 dBTP</option>
                  <option value={-2.0}>-2.0 dBTP</option>
                </select>
              </div>
            )}
          </div>
        </div>

        {/* Column 3: Batch Summary */}
        <div className="lg:col-span-3 p-5 flex flex-col justify-between gap-4 bg-[#0d131f]">
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-sm font-semibold text-white">
                Batch Metrics
              </h2>
              {overriddenCount > 0 && (
                <button
                  type="button"
                  onClick={onResetOverrides}
                  className="inline-flex items-center gap-1 text-xs font-medium text-blue-400 hover:text-blue-300 cursor-pointer"
                >
                  <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Reset {overriddenCount}</span>
                </button>
              )}
            </div>

            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs pt-1">
              <div>
                <dt className="text-slate-400">Selected</dt>
                <dd className="font-mono font-semibold text-sm text-white tabular-nums mt-0.5">
                  {selectedCount} / {tracks.length}
                </dd>
              </div>
              <div>
                <dt className="text-slate-400">Mean LUFS</dt>
                <dd className="font-mono font-semibold text-sm text-white tabular-nums mt-0.5">
                  {avgLufs !== null ? `${avgLufs.toFixed(1)}` : '—'}
                </dd>
              </div>
              <div>
                <dt className="text-slate-400">Media Tags</dt>
                <dd className="font-mono font-medium text-slate-200 tabular-nums mt-0.5">
                  {artCount} art · {lyricsCount} lyr
                </dd>
              </div>
              <div>
                <dt className="text-slate-400">Formats</dt>
                <dd className="font-mono font-medium text-slate-200 tabular-nums mt-0.5">
                  {mp3Count} MP3 · {nonMp3Count} oth
                </dd>
              </div>
            </dl>
          </div>

          <p className="text-xs text-slate-400 leading-relaxed">
            Adjust individual tracks below, preview before &amp; after, then save at the bottom.
          </p>
        </div>
      </div>
    </section>
  );
};
