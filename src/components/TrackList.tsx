import React, { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { computeTrackGain } from '../audio/loudnessAnalyzer';
import type { NormalizationSettings, TrackItem } from '../types/audio';
import { TrackCard } from './TrackCard';

interface TrackListProps {
  tracks: TrackItem[];
  settings: NormalizationSettings;
  activeTrackId: string | null;
  isPlaying: boolean;
  positions: Record<string, number>;
  normalizedByTrack: Record<string, boolean>;
  onToggleSelect: (id: string) => void;
  onToggleSelectAll: () => void;
  onChangeManualGain: (id: string, gainDb: number | null) => void;
  onRemoveTrack: (id: string) => void;
  onClearAll: () => void;
  onTogglePlay: (track: TrackItem) => void;
  onTogglePreviewMode: (trackId: string) => void;
  onSeekTrack: (track: TrackItem, timeSec: number) => void;
  onInspectTrack: (track: TrackItem) => void;
}

type FilterTab = 'all' | 'boostable' | 'attention' | 'media';

export const TrackList: React.FC<TrackListProps> = ({
  tracks,
  settings,
  activeTrackId,
  isPlaying,
  positions,
  normalizedByTrack,
  onToggleSelect,
  onToggleSelectAll,
  onChangeManualGain,
  onRemoveTrack,
  onClearAll,
  onTogglePlay,
  onTogglePreviewMode,
  onSeekTrack,
  onInspectTrack,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [filterTab, setFilterTab] = useState<FilterTab>('all');

  const computedByTrackId = useMemo(() => {
    const map = new Map<string, ReturnType<typeof computeTrackGain>>();
    for (const t of tracks) {
      if (t.analysis) {
        map.set(
          t.id,
          computeTrackGain(
            t.analysis,
            settings,
            t.manualGainOverrideDb,
            t.format === 'mp3'
          )
        );
      }
    }
    return map;
  }, [tracks, settings]);

  const filteredTracks = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return tracks.filter((t) => {
      if (q) {
        const hay = `${t.fileName} ${t.metadata?.title ?? ''} ${t.metadata?.artist ?? ''} ${
          t.metadata?.album ?? ''
        }`.toLowerCase();
        if (!hay.includes(q)) return false;
      }

      if (filterTab === 'boostable') {
        return t.analysis ? t.analysis.maxSafeGainDb > 0.5 : false;
      }
      if (filterTab === 'attention') {
        const comp = computedByTrackId.get(t.id);
        return comp ? comp.limitingRequiredDb > 0.05 || comp.wouldClip : false;
      }
      if (filterTab === 'media') {
        return Boolean(t.metadata?.artwork || t.metadata?.lyrics);
      }
      return true;
    });
  }, [tracks, searchQuery, filterTab, computedByTrackId]);

  const allSelected =
    tracks.length > 0 &&
    tracks.every((t) => t.selected || t.status === 'analyzing' || t.status === 'error');

  if (tracks.length === 0) {
    return (
      <section
        aria-label="Track Analysis Queue"
        className="bg-[#111827] border border-slate-800 rounded-xl p-10 text-center"
      >
        <p className="text-sm font-medium text-slate-200">
          No audio files in queue yet
        </p>
        <p className="text-xs text-slate-400 mt-1">
          Use the single file input bar at the top of the page to load MP3, M4A, or AAC tracks for analysis and preview.
        </p>
      </section>
    );
  }

  return (
    <section
      aria-label="Track Analysis and Preview Queue"
      className="space-y-4"
    >
      {/* Queue Toolbar */}
      <div className="bg-[#111827] border border-slate-800 rounded-xl px-5 py-3 flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-200 cursor-pointer mr-1">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={onToggleSelectAll}
              className="w-4 h-4 rounded border-slate-700 bg-slate-950 text-blue-500 focus:ring-blue-500 cursor-pointer"
            />
            <span>Select All</span>
          </label>

          <div className="relative">
            <Search
              className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
              aria-hidden="true"
            />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter tracks..."
              aria-label="Filter tracks"
              className="pl-9 pr-3 h-8 w-52 text-xs bg-slate-950 border border-slate-800 rounded-lg text-slate-100 placeholder:text-slate-500 focus:outline-2 focus:outline-blue-500"
            />
          </div>

          <div
            role="tablist"
            aria-label="Track status filter"
            className="inline-flex items-center p-0.5 bg-slate-950 border border-slate-800 rounded-lg"
          >
            {(
              [
                { id: 'all', label: `All (${tracks.length})` },
                { id: 'boostable', label: 'Has Headroom' },
                { id: 'attention', label: 'Limiting / Clip' },
                { id: 'media', label: 'Art & Lyrics' },
              ] as { id: FilterTab; label: string }[]
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={filterTab === tab.id}
                onClick={() => setFilterTab(tab.id)}
                className={`px-3 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  filterTab === tab.id
                    ? 'bg-slate-800 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        <button
          type="button"
          onClick={onClearAll}
          className="text-xs font-medium text-slate-400 hover:text-red-400 transition-colors cursor-pointer whitespace-nowrap"
        >
          Clear Queue
        </button>
      </div>

      {/* Per-File Complete Cards */}
      {filteredTracks.length === 0 ? (
        <div className="bg-[#111827] border border-slate-800 rounded-xl py-10 text-center text-sm text-slate-400">
          No tracks match your current filter.
        </div>
      ) : (
        <div className="space-y-4">
          {filteredTracks.map((track) => (
            <TrackCard
              key={track.id}
              track={track}
              settings={settings}
              isPlaying={activeTrackId === track.id && isPlaying}
              currentTime={positions[track.id] ?? 0}
              previewNormalized={normalizedByTrack[track.id] ?? true}
              onToggleSelect={onToggleSelect}
              onChangeManualGain={onChangeManualGain}
              onRemoveTrack={onRemoveTrack}
              onInspectTrack={onInspectTrack}
              onTogglePlay={() => onTogglePlay(track)}
              onTogglePreviewMode={() => onTogglePreviewMode(track.id)}
              onSeek={(sec) => onSeekTrack(track, sec)}
            />
          ))}
        </div>
      )}
    </section>
  );
};
