import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  CopyPlus,
  Download,
  FileWarning,
  FolderCheck,
  FolderOpen,
  RefreshCw,
  ShieldCheck,
  X,
} from 'lucide-react';
import {
  clearSavedOutputDirHandle,
  downloadBatchAsZip,
  ensureDirectoryWritePermission,
  getOrCreateMusicNormalizedDir,
  loadSavedOutputDirHandle,
  pickOutputDirectoryHandle,
  triggerBrowserDownload,
  writeFileInPlace,
  writeSiblingFileInDir,
  type FileSystemCapabilities,
} from '../audio/fileHandles';
import { computeTrackGain } from '../audio/loudnessAnalyzer';
import { processTrackToMp3 } from '../audio/mp3Processor';
import type {
  ExportNamingMode,
  NormalizationSettings,
  TrackItem,
} from '../types/audio';

interface ExportModalProps {
  isOpen: boolean;
  tracks: TrackItem[];
  settings: NormalizationSettings;
  fsCaps: FileSystemCapabilities;
  onClose: () => void;
  onTrackExported: (id: string, result: NonNullable<TrackItem['exportResult']>) => void;
}

interface ExportLogItem {
  id: string;
  fileName: string;
  outputFileName: string;
  appliedGainDb: number;
  limitingUsedDb: number;
  id3PreservedBytes: number;
  tailPreservedBytes: number;
  actionTaken: 'saved_to_music_normalized' | 'replaced' | 'created_norm' | 'downloaded';
  destinationLabel?: string;
  error?: string;
}

export const ExportModal: React.FC<ExportModalProps> = ({
  isOpen,
  tracks,
  settings,
  fsCaps,
  onClose,
  onTrackExported,
}) => {
  const [namingMode, setNamingMode] = useState<ExportNamingMode>(
    fsCaps.canReplaceOriginalsDirectly ? 'folder_music_normalized' : 'norm_suffix'
  );
  const [outputDirHandle, setOutputDirHandle] =
    useState<FileSystemDirectoryHandle | null>(null);
  const [isRememberedFolder, setIsRememberedFolder] = useState(false);
  const [folderError, setFolderError] = useState<string | null>(null);
  const [downloadAsZip, setDownloadAsZip] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [currentTrackIdx, setCurrentTrackIdx] = useState(0);
  const [currentTrackPct, setCurrentTrackPct] = useState(0);
  const [results, setResults] = useState<ExportLogItem[] | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setResults(null);
    setFolderError(null);
    setNamingMode(
      fsCaps.canReplaceOriginalsDirectly ? 'folder_music_normalized' : 'norm_suffix'
    );

    if (fsCaps.canReplaceOriginalsDirectly) {
      void loadSavedOutputDirHandle().then((saved) => {
        if (saved) {
          setOutputDirHandle(saved);
          setIsRememberedFolder(true);
        }
      });
    }
  }, [isOpen, fsCaps.canReplaceOriginalsDirectly]);

  if (!isOpen) return null;

  const selectedTracks = tracks.filter(
    (t) => t.selected && (t.status === 'ready' || t.status === 'done')
  );

  const tracksWithWriteHandle = selectedTracks.filter(
    (t) => Boolean(t.fileHandle) && t.format === 'mp3'
  );
  const tracksWithDirHandle = selectedTracks.filter((t) => Boolean(t.parentDirHandle));

  const canReplaceAll =
    fsCaps.canReplaceOriginalsDirectly &&
    selectedTracks.length > 0 &&
    tracksWithWriteHandle.length === selectedTracks.length;

  const canReplaceSome =
    fsCaps.canReplaceOriginalsDirectly && tracksWithWriteHandle.length > 0;

  const handleChooseOutputFolder = async () => {
    setFolderError(null);
    try {
      const { dirHandle, blockedBySecurity } = await pickOutputDirectoryHandle();
      if (blockedBySecurity) {
        setFolderError(
          'Your browser blocked direct folder access here. Open GainBench in a standalone desktop Chrome or Edge tab to save directly to a folder.'
        );
        return;
      }
      if (dirHandle) {
        setOutputDirHandle(dirHandle);
        setIsRememberedFolder(false);
        setNamingMode('folder_music_normalized');
      }
    } catch (err) {
      setFolderError(
        err instanceof Error ? err.message : 'Could not open folder picker.'
      );
    }
  };

  const handleClearSavedFolder = async () => {
    await clearSavedOutputDirHandle();
    setOutputDirHandle(null);
    setIsRememberedFolder(false);
    setFolderError(null);
  };

  const folderNeedsSelection =
    namingMode === 'folder_music_normalized' && !outputDirHandle;

  const handleStartExport = async () => {
    if (selectedTracks.length === 0) return;
    setFolderError(null);

    let musicNormalizedTargetDir: FileSystemDirectoryHandle | null = null;
    let folderPathPrefix = '';

    if (namingMode === 'folder_music_normalized') {
      if (!outputDirHandle) {
        setFolderError('Please choose an output folder before starting.');
        return;
      }
      const granted = await ensureDirectoryWritePermission(outputDirHandle);
      if (!granted) {
        setFolderError(
          'Write permission to the chosen folder was declined. Click "Choose Folder" to select or re-authorize it.'
        );
        return;
      }
      try {
        musicNormalizedTargetDir = await getOrCreateMusicNormalizedDir(outputDirHandle);
        folderPathPrefix =
          outputDirHandle.name === 'music_normalized'
            ? 'music_normalized/'
            : `${outputDirHandle.name}/music_normalized/`;
      } catch (err) {
        setFolderError(
          err instanceof Error
            ? `Could not create music_normalized folder: ${err.message}`
            : 'Could not create music_normalized folder.'
        );
        return;
      }
    }

    setIsRunning(true);
    setResults(null);
    setCurrentTrackIdx(0);
    setCurrentTrackPct(0);

    const log: ExportLogItem[] = [];
    const zipItems: { fileName: string; bytes: Uint8Array }[] = [];

    for (let i = 0; i < selectedTracks.length; i++) {
      const track = selectedTracks[i];
      setCurrentTrackIdx(i);
      setCurrentTrackPct(0);

      try {
        if (!track.analysis) throw new Error('Track not analyzed');
        const computed = computeTrackGain(
          track.analysis,
          settings,
          track.manualGainOverrideDb,
          track.format === 'mp3'
        );

        const addNormSuffix = namingMode !== 'replace';
        const output = await processTrackToMp3(
          track,
          computed,
          settings,
          addNormSuffix,
          (pct) => setCurrentTrackPct(pct)
        );

        let actionTaken: ExportLogItem['actionTaken'] = 'downloaded';
        let destinationLabel: string | undefined;

        if (namingMode === 'folder_music_normalized' && musicNormalizedTargetDir) {
          // Save directly inside <ChosenFolder>/music_normalized/ with NO ZIP
          await writeSiblingFileInDir(
            musicNormalizedTargetDir,
            output.outputFileName,
            output.bytes
          );
          actionTaken = 'saved_to_music_normalized';
          destinationLabel = `${folderPathPrefix}${output.outputFileName}`;
        } else if (namingMode === 'replace') {
          if (track.fileHandle && track.format === 'mp3' && fsCaps.canReplaceOriginalsDirectly) {
            await writeFileInPlace(track.fileHandle, output.bytes);
            actionTaken = 'replaced';
          } else {
            const safeName = `${track.fileName.replace(/\.[^/.]+$/, '')}_norm.mp3`;
            zipItems.push({ fileName: safeName, bytes: output.bytes });
            actionTaken = 'downloaded';
          }
        } else {
          if (track.parentDirHandle && fsCaps.canReplaceOriginalsDirectly) {
            await writeSiblingFileInDir(
              track.parentDirHandle,
              output.outputFileName,
              output.bytes
            );
            actionTaken = 'created_norm';
          } else {
            zipItems.push({ fileName: output.outputFileName, bytes: output.bytes });
            actionTaken = 'downloaded';
          }
        }

        const exportRes: NonNullable<TrackItem['exportResult']> = {
          outputFileName: output.outputFileName,
          outputSizeBytes: output.bytes.length,
          appliedGainDb: output.appliedGainDb,
          limitingUsedDb: output.limitingUsedDb,
          id3PreservedBytes: output.id3PreservedBytes,
          tailPreservedBytes: output.tailPreservedBytes,
          modeUsed: settings.engineMode,
          actionTaken,
        };

        onTrackExported(track.id, exportRes);
        log.push({
          id: track.id,
          fileName: track.fileName,
          outputFileName: output.outputFileName,
          appliedGainDb: output.appliedGainDb,
          limitingUsedDb: output.limitingUsedDb,
          id3PreservedBytes: output.id3PreservedBytes,
          tailPreservedBytes: output.tailPreservedBytes,
          actionTaken,
          destinationLabel,
        });
      } catch (err) {
        log.push({
          id: track.id,
          fileName: track.fileName,
          outputFileName: track.fileName,
          appliedGainDb: 0,
          limitingUsedDb: 0,
          id3PreservedBytes: 0,
          tailPreservedBytes: 0,
          actionTaken: 'downloaded',
          error: err instanceof Error ? err.message : 'Export failed',
        });
      }
    }

    if (zipItems.length > 0) {
      if (zipItems.length > 1 && downloadAsZip) {
        await downloadBatchAsZip(zipItems, 'music_normalized.zip');
      } else {
        for (const item of zipItems) {
          triggerBrowserDownload(item.fileName, item.bytes, 'audio/mpeg');
        }
      }
    }

    setResults(log);
    setIsRunning(false);
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="export-dialog-title"
      onClick={() => {
        if (!isRunning) onClose();
      }}
    >
      <div
        className="bg-[#111827] border border-slate-800 rounded-xl w-full max-w-xl max-h-[88vh] flex flex-col overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between gap-4">
          <div>
            <h2
              id="export-dialog-title"
              className="font-display text-base font-semibold text-white"
            >
              Apply Normalization &amp; Save Files
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              {selectedTracks.length} track{selectedTracks.length === 1 ? '' : 's'} queued ·{' '}
              {settings.engineMode === 'lossless'
                ? 'Lossless 1.5 dB Header Patch'
                : 'Exact 0.1 dB Re-encode'}
            </p>
          </div>
          {!isRunning && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close export modal"
              className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Body */}
        <div className="p-6 overflow-y-auto space-y-5">
          {!isRunning && !results && (
            <>
              <div className="space-y-3">
                <p className="text-sm font-medium text-white">
                  Where should the normalized files be saved?
                </p>

                {/* Option 1: Save directly to chosen folder / music_normalized (no ZIP) */}
                <div
                  onClick={() => {
                    if (fsCaps.canReplaceOriginalsDirectly) {
                      setNamingMode('folder_music_normalized');
                    }
                  }}
                  className={`p-4 rounded-xl border transition-colors space-y-3 ${
                    !fsCaps.canReplaceOriginalsDirectly
                      ? 'border-slate-800 bg-slate-950/40 opacity-60 cursor-not-allowed'
                      : namingMode === 'folder_music_normalized'
                        ? 'border-blue-500 bg-blue-950/30 cursor-pointer'
                        : 'border-slate-800 bg-slate-950/60 hover:border-slate-700 cursor-pointer'
                  }`}
                >
                  <label className="flex items-start gap-3.5 cursor-pointer">
                    <input
                      type="radio"
                      name="export-naming-mode"
                      disabled={!fsCaps.canReplaceOriginalsDirectly}
                      checked={namingMode === 'folder_music_normalized'}
                      onChange={() => setNamingMode('folder_music_normalized')}
                      className="mt-1 text-blue-500 focus:ring-blue-500 bg-slate-900 border-slate-700 disabled:opacity-50"
                    />
                    <div className="space-y-1 flex-1">
                      <div className="flex items-center gap-2 text-sm font-semibold text-white">
                        <FolderCheck className="w-4 h-4 text-blue-400" aria-hidden="true" />
                        <span>Save directly to &quot;music_normalized&quot; folder (No ZIP)</span>
                      </div>
                      <p className="text-xs text-slate-400 leading-relaxed">
                        {fsCaps.canReplaceOriginalsDirectly
                          ? 'Choose your Music folder (or any folder) before starting. Saves each MP3 directly inside a "music_normalized" subfolder and remembers your folder for next time.'
                          : fsCaps.isEmbeddedIframe
                            ? 'Direct folder access is blocked inside an embedded frame. Open GainBench in a standalone desktop Chrome/Edge tab to save directly to a folder, or use Browser Download below.'
                            : 'Direct folder access is not supported in this browser. Use Browser Download below.'}
                      </p>
                    </div>
                  </label>

                  {fsCaps.canReplaceOriginalsDirectly &&
                    namingMode === 'folder_music_normalized' && (
                      <div
                        className="ml-7 p-3 rounded-lg bg-[#0b0f17] border border-slate-800 flex flex-wrap items-center justify-between gap-3"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="min-w-0 space-y-0.5">
                          <div className="text-xs font-medium text-slate-300">
                            {outputDirHandle ? (
                              <>
                                Destination:{' '}
                                <span className="font-mono text-white">
                                  {outputDirHandle.name === 'music_normalized'
                                    ? 'music_normalized/'
                                    : `${outputDirHandle.name}/music_normalized/`}
                                </span>
                                {isRememberedFolder && (
                                  <span className="text-slate-400"> (Remembered)</span>
                                )}
                              </>
                            ) : (
                              <span className="text-amber-300">
                                Required: Choose your Music or output folder before starting
                              </span>
                            )}
                          </div>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          {outputDirHandle && (
                            <button
                              type="button"
                              onClick={handleClearSavedFolder}
                              className="px-2.5 py-1.5 text-xs font-medium text-slate-400 hover:text-white border border-slate-800 hover:border-slate-700 rounded-md cursor-pointer"
                            >
                              Forget
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={handleChooseOutputFolder}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-500 rounded-md transition-colors cursor-pointer"
                          >
                            <FolderOpen className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>{outputDirHandle ? 'Change Folder' : 'Choose Folder'}</span>
                          </button>
                        </div>
                      </div>
                    )}
                </div>

                {/* Option 2: Create new file with _norm (same folder or browser download) */}
                <label
                  className={`flex items-start gap-3.5 p-4 rounded-xl border cursor-pointer transition-colors ${
                    namingMode === 'norm_suffix'
                      ? 'border-blue-500 bg-blue-950/30'
                      : 'border-slate-800 bg-slate-950/60 hover:border-slate-700'
                  }`}
                >
                  <input
                    type="radio"
                    name="export-naming-mode"
                    checked={namingMode === 'norm_suffix'}
                    onChange={() => setNamingMode('norm_suffix')}
                    className="mt-1 text-blue-500 focus:ring-blue-500 bg-slate-900 border-slate-700"
                  />
                  <div className="space-y-1 flex-1">
                    <div className="flex items-center gap-2 text-sm font-semibold text-white">
                      <CopyPlus className="w-4 h-4 text-slate-300" aria-hidden="true" />
                      <span>
                        {tracksWithDirHandle.length === selectedTracks.length &&
                        fsCaps.canReplaceOriginalsDirectly
                          ? 'Save "_norm" files alongside originals'
                          : 'Download "_norm" files via browser'}
                      </span>
                    </div>
                    <p className="text-xs text-slate-400 leading-relaxed">
                      Creates <span className="font-mono text-slate-200">TrackName_norm.mp3</span>{' '}
                      {tracksWithDirHandle.length === selectedTracks.length &&
                      fsCaps.canReplaceOriginalsDirectly
                        ? 'directly inside the source folder alongside your original files.'
                        : 'directly to your browser Downloads folder (originals remain untouched).'}
                    </p>
                  </div>
                </label>

                {/* Option 3: Replace original files */}
                <label
                  className={`flex items-start gap-3.5 p-4 rounded-xl border transition-colors ${
                    !canReplaceSome
                      ? 'border-slate-800 bg-slate-950/40 opacity-60 cursor-not-allowed'
                      : namingMode === 'replace'
                        ? 'border-blue-500 bg-blue-950/30 cursor-pointer'
                        : 'border-slate-800 bg-slate-950/60 hover:border-slate-700 cursor-pointer'
                  }`}
                >
                  <input
                    type="radio"
                    name="export-naming-mode"
                    disabled={!canReplaceSome}
                    checked={namingMode === 'replace'}
                    onChange={() => setNamingMode('replace')}
                    className="mt-1 text-blue-500 focus:ring-blue-500 bg-slate-900 border-slate-700 disabled:opacity-50"
                  />
                  <div className="space-y-1 flex-1">
                    <div className="flex items-center gap-2 text-sm font-semibold text-white">
                      <RefreshCw className="w-4 h-4 text-slate-300" aria-hidden="true" />
                      <span>Replace original files in place</span>
                    </div>
                    <p className="text-xs text-slate-400 leading-relaxed">
                      {canReplaceAll
                        ? 'Overwrites the selected MP3 files directly on disk using your granted file permissions.'
                        : canReplaceSome
                          ? `Available for ${tracksWithWriteHandle.length} of ${selectedTracks.length} tracks with direct MP3 write handles; remaining tracks will download as _norm.`
                          : fsCaps.isEmbeddedIframe
                            ? 'Unavailable inside an embedded iframe preview due to browser security restrictions.'
                            : 'Unavailable because files were added without direct file write handles. Use "Open Folder" or "Select Audio Files" in Chrome or Edge to enable direct replacement.'}
                    </p>
                  </div>
                </label>
              </div>

              {folderError && (
                <div className="bg-red-950/40 border border-red-800/60 rounded-lg p-3 flex items-start gap-2.5 text-xs text-red-200">
                  <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" aria-hidden="true" />
                  <span>{folderError}</span>
                </div>
              )}

              {namingMode === 'norm_suffix' &&
                tracksWithDirHandle.length < selectedTracks.length &&
                selectedTracks.length > 1 && (
                  <label className="flex items-center gap-2.5 text-xs text-slate-300 pt-1 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={downloadAsZip}
                      onChange={(e) => setDownloadAsZip(e.target.checked)}
                      className="rounded border-slate-700 bg-slate-950 text-blue-500 focus:ring-blue-500"
                    />
                    <span>Bundle browser downloads into a single ZIP file instead of individual files</span>
                  </label>
                )}

              <div className="bg-slate-950/70 border border-slate-800 rounded-lg p-3.5 flex items-start gap-2.5 text-xs text-slate-300">
                <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" aria-hidden="true" />
                <span>
                  ID3v2 header bytes, embedded cover images, lyrics frames, and ID3v1 tails will be copied byte-for-byte untouched for every MP3 track.
                </span>
              </div>
            </>
          )}

          {/* Running Progress */}
          {isRunning && (
            <div className="py-6 space-y-4">
              <div className="flex items-center justify-between text-sm font-medium text-white">
                <span className="truncate pr-4">
                  Processing {currentTrackIdx + 1} of {selectedTracks.length}:{' '}
                  {selectedTracks[currentTrackIdx]?.fileName}
                </span>
                <span className="font-mono tabular-nums shrink-0">
                  {currentTrackPct}%
                </span>
              </div>
              <div className="w-full h-2.5 bg-slate-950 rounded-full overflow-hidden border border-slate-800">
                <div
                  className="h-full bg-blue-600 transition-all duration-150"
                  style={{
                    width: `${Math.round(
                      ((currentTrackIdx + currentTrackPct / 100) /
                        Math.max(1, selectedTracks.length)) *
                        100
                    )}%`,
                  }}
                />
              </div>
              <p className="text-xs text-slate-400">
                Running locally in browser memory. Please keep this tab open until complete.
              </p>
            </div>
          )}

          {/* Results Summary */}
          {results && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-emerald-300 bg-emerald-950/40 border border-emerald-800/60 rounded-lg p-3.5">
                <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span>
                  Completed {results.filter((r) => !r.error).length} of {results.length} tracks
                </span>
              </div>

              <div className="border border-slate-800 bg-slate-950/60 rounded-lg divide-y divide-slate-800 max-h-64 overflow-y-auto">
                {results.map((item) => (
                  <div
                    key={item.id}
                    className="px-3.5 py-2.5 flex items-center justify-between gap-3 text-xs"
                  >
                    <div className="min-w-0">
                      <div className="font-medium text-white truncate">
                        {item.destinationLabel || item.outputFileName}
                      </div>
                      {item.error ? (
                        <div className="text-red-400 flex items-center gap-1 mt-0.5">
                          <FileWarning className="w-3 h-3" aria-hidden="true" />
                          <span>{item.error}</span>
                        </div>
                      ) : (
                        <div className="text-slate-400 font-mono tabular-nums mt-0.5">
                          {item.appliedGainDb >= 0 ? '+' : ''}
                          {item.appliedGainDb.toFixed(1)} dB · ID3{' '}
                          {(item.id3PreservedBytes + item.tailPreservedBytes).toLocaleString()}B untouched
                          {item.limitingUsedDb > 0.05
                            ? ` · Limiter -${item.limitingUsedDb.toFixed(1)} dB`
                            : ''}
                        </div>
                      )}
                    </div>
                    <span className="font-mono text-[11px] text-slate-300 shrink-0">
                      {item.actionTaken === 'saved_to_music_normalized'
                        ? 'Saved to folder'
                        : item.actionTaken === 'replaced'
                          ? 'Replaced'
                          : item.actionTaken === 'created_norm'
                            ? 'Saved _norm'
                            : 'Downloaded'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-800 bg-[#0d131f] flex items-center justify-end gap-3">
          {!isRunning && !results && (
            <>
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium text-slate-300 hover:text-white cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={folderNeedsSelection}
                onClick={handleStartExport}
                className="inline-flex items-center gap-2 px-5 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-500 disabled:bg-slate-800 disabled:text-slate-500 disabled:cursor-not-allowed rounded-lg transition-colors cursor-pointer"
              >
                <Download className="w-4 h-4" aria-hidden="true" />
                <span>
                  {namingMode === 'folder_music_normalized'
                    ? 'Save to music_normalized'
                    : namingMode === 'replace'
                      ? 'Replace Originals'
                      : 'Export "_norm" Batch'}
                </span>
              </button>
            </>
          )}
          {results && (
            <button
              type="button"
              onClick={onClose}
              className="px-5 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-500 rounded-lg transition-colors cursor-pointer"
            >
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
