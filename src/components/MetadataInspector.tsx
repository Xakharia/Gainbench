import React from 'react';
import { X, Music, FileText, Image as ImageIcon, ShieldCheck } from 'lucide-react';
import type { TrackItem } from '../types/audio';

interface MetadataInspectorProps {
  track: TrackItem | null;
  onClose: () => void;
}

export const MetadataInspector: React.FC<MetadataInspectorProps> = ({ track, onClose }) => {
  if (!track) return null;

  const meta = track.metadata;
  const art = meta?.artwork;
  const lyrics = meta?.lyrics;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="inspector-title"
      onClick={onClose}
    >
      <div
        className="bg-[#111827] border border-slate-800 rounded-xl w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h2
              id="inspector-title"
              className="font-display text-base font-semibold text-white truncate"
            >
              ID3 Tag &amp; Media Verification
            </h2>
            <p className="text-xs text-slate-400 truncate mt-0.5 font-mono">
              {track.fileName}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close inspector"
            className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 overflow-y-auto space-y-6">
          {/* Byte Preservation Proof */}
          <div className="bg-emerald-950/40 border border-emerald-800/60 rounded-lg p-4 flex items-start gap-3">
            <ShieldCheck className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" aria-hidden="true" />
            <div className="text-xs text-emerald-100 space-y-1">
              <p className="font-semibold">
                {track.format === 'mp3'
                  ? 'Original ID3 Header & Tail Bytes Preserved Untouched'
                  : 'Non-MP3 Source Container Notice'}
              </p>
              {track.format === 'mp3' && meta ? (
                <p className="text-emerald-200/80 leading-relaxed">
                  Header block ({meta.id3v2Version ?? 'No ID3v2'},{' '}
                  <span className="font-mono tabular-nums text-emerald-100">
                    {meta.id3v2ByteLength.toLocaleString()} bytes
                  </span>
                  ) and tail block (
                  <span className="font-mono tabular-nums text-emerald-100">
                    {meta.tailByteLength.toLocaleString()} bytes
                  </span>
                  ) are sliced directly from the source binary and restored byte-for-byte after gain processing.
                </p>
              ) : (
                <p className="text-emerald-200/80 leading-relaxed">
                  Native browser engine decodes {track.format.toUpperCase()} for analysis and preview. Exporting writes a normalized 320 kbps MP3 without source MP4 atoms.
                </p>
              )}
            </div>
          </div>

          {/* Artwork + Core Fields (1 piece per line) */}
          <div className="grid grid-cols-1 sm:grid-cols-12 gap-5 items-start">
            <div className="sm:col-span-4">
              <div className="aspect-square rounded-lg border border-slate-800 bg-slate-950 overflow-hidden flex items-center justify-center">
                {art ? (
                  <img
                    src={art.objectUrl}
                    alt={`Cover art for ${meta?.title ?? track.fileName}`}
                    referrerPolicy="no-referrer"
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="flex flex-col items-center gap-2 text-slate-500 p-4 text-center">
                    <Music className="w-8 h-8" aria-hidden="true" />
                    <span className="text-xs">No Embedded Cover Art</span>
                  </div>
                )}
              </div>
              {art && (
                <p className="mt-2 text-xs text-slate-400 font-mono tabular-nums flex items-center gap-1.5">
                  <ImageIcon className="w-3.5 h-3.5 text-slate-500" aria-hidden="true" />
                  <span>
                    {art.mimeType} · {(art.byteLength / 1024).toFixed(1)} KB
                  </span>
                </p>
              )}
            </div>

            <div className="sm:col-span-8">
              <dl className="divide-y divide-slate-800 text-xs border border-slate-800 rounded-lg bg-slate-950/60">
                <div className="px-3.5 py-2.5 flex items-center justify-between gap-4">
                  <dt className="text-slate-400 shrink-0">Title (TIT2)</dt>
                  <dd className="text-slate-100 font-medium truncate text-right">
                    {meta?.title || '—'}
                  </dd>
                </div>
                <div className="px-3.5 py-2.5 flex items-center justify-between gap-4">
                  <dt className="text-slate-400 shrink-0">Artist (TPE1)</dt>
                  <dd className="text-slate-100 font-medium truncate text-right">
                    {meta?.artist || '—'}
                  </dd>
                </div>
                <div className="px-3.5 py-2.5 flex items-center justify-between gap-4">
                  <dt className="text-slate-400 shrink-0">Album (TALB)</dt>
                  <dd className="text-slate-100 truncate text-right">
                    {meta?.album || '—'}
                  </dd>
                </div>
                <div className="px-3.5 py-2.5 flex items-center justify-between gap-4">
                  <dt className="text-slate-400 shrink-0">Year (TYER / TDRC)</dt>
                  <dd className="text-slate-100 font-mono tabular-nums text-right">
                    {meta?.year || '—'}
                  </dd>
                </div>
                <div className="px-3.5 py-2.5 flex items-center justify-between gap-4">
                  <dt className="text-slate-400 shrink-0">ID3 Frames</dt>
                  <dd className="text-slate-300 font-mono truncate text-right">
                    {meta && meta.frameIds.length > 0
                      ? Array.from(new Set(meta.frameIds)).join(', ')
                      : 'None detected'}
                  </dd>
                </div>
              </dl>
            </div>
          </div>

          {/* Embedded Lyrics */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-slate-300 inline-flex items-center gap-1.5">
                <FileText className="w-3.5 h-3.5 text-slate-400" aria-hidden="true" />
                <span>
                  Embedded Lyrics ({lyrics?.isSynchronized ? 'SYLT Synchronized' : 'USLT Unsynchronized'})
                </span>
              </span>
              {lyrics && (
                <span className="font-mono text-slate-400 tabular-nums">
                  {lyrics.language.toUpperCase()} · {lyrics.byteLength.toLocaleString()} bytes
                </span>
              )}
            </div>
            {lyrics ? (
              <pre className="bg-slate-950 border border-slate-800 rounded-lg p-4 text-xs text-slate-200 whitespace-pre-wrap font-sans max-h-52 overflow-y-auto leading-relaxed">
                {lyrics.text}
              </pre>
            ) : (
              <div className="bg-slate-950 border border-slate-800 rounded-lg p-4 text-xs text-slate-400">
                No USLT or SYLT lyrics frame detected in this file.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
