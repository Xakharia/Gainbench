import { useCallback, useEffect, useRef, useState } from 'react';
import { computeTrackGain } from './loudnessAnalyzer';
import { processPcmWithGainAndLimiter } from './mp3Processor';
import type { NormalizationSettings, TrackItem } from '../types/audio';

export function useAudioPreview(
  tracks: TrackItem[],
  settings: NormalizationSettings
) {
  const [activeTrackId, setActiveTrackId] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [positions, setPositions] = useState<Record<string, number>>({});
  const [normalizedByTrack, setNormalizedByTrack] = useState<
    Record<string, boolean>
  >({});

  const audioCtxRef = useRef<AudioContext | null>(null);
  const activeSourceRef = useRef<AudioBufferSourceNode | null>(null);

  // Monotonic session token prevents async race conditions or double simultaneous playback
  const playSessionRef = useRef(0);
  const startCtxTimeRef = useRef(0);
  const startOffsetRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const activeDurationRef = useRef(0);

  // Small LRU PCM cache (max 2 tracks) so multi-file batches stay lightweight in RAM
  const pcmCacheRef = useRef<
    Map<string, { sampleRate: number; channels: Float32Array[] }>
  >(new Map());

  const stopActiveSource = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (activeSourceRef.current) {
      try {
        activeSourceRef.current.onended = null;
        activeSourceRef.current.stop();
        activeSourceRef.current.disconnect();
      } catch {
        // Ignore already stopped
      }
      activeSourceRef.current = null;
    }
  }, []);

  const getCurrentElapsed = useCallback((fallback: number, duration: number): number => {
    if (!audioCtxRef.current || !activeSourceRef.current) {
      return fallback;
    }
    const elapsed =
      startOffsetRef.current +
      Math.max(0, audioCtxRef.current.currentTime - startCtxTimeRef.current);
    return Math.max(0, Math.min(duration, elapsed));
  }, []);

  const ensurePcmForTrack = useCallback(
    async (
      track: TrackItem
    ): Promise<{ sampleRate: number; channels: Float32Array[] } | null> => {
      if (track.pcmChannels && track.pcmChannels.length > 0 && track.analysis) {
        return {
          sampleRate: track.analysis.sampleRate,
          channels: track.pcmChannels,
        };
      }
      const cached = pcmCacheRef.current.get(track.id);
      if (cached) return cached;

      if (!audioCtxRef.current) {
        audioCtxRef.current = new AudioContext();
      }
      const ctx = audioCtxRef.current;
      const arrBuf = await track.file.arrayBuffer();
      const decoded = await ctx.decodeAudioData(arrBuf);
      const channels: Float32Array[] = [];
      for (let c = 0; c < decoded.numberOfChannels; c++) {
        channels.push(new Float32Array(decoded.getChannelData(c)));
      }
      const entry = { sampleRate: decoded.sampleRate, channels };
      if (pcmCacheRef.current.size >= 2) {
        const oldestKey = pcmCacheRef.current.keys().next().value;
        if (oldestKey) pcmCacheRef.current.delete(oldestKey);
      }
      pcmCacheRef.current.set(track.id, entry);
      return entry;
    },
    []
  );

  const startSingleSourceAtOffset = useCallback(
    async (track: TrackItem, offsetSec: number, listenNormalized: boolean) => {
      const mySession = ++playSessionRef.current;
      // Synchronously stop ANY previous track/source before awaiting decode
      stopActiveSource();

      if (!track.analysis) return;

      if (!audioCtxRef.current) {
        audioCtxRef.current = new AudioContext();
      }
      const ctx = audioCtxRef.current;
      if (ctx.state === 'suspended') {
        await ctx.resume();
      }
      if (playSessionRef.current !== mySession) return;

      const pcmData = await ensurePcmForTrack(track);
      if (playSessionRef.current !== mySession) return;
      if (!pcmData || pcmData.channels.length === 0) return;

      const sr = pcmData.sampleRate;
      const len = pcmData.channels[0].length;
      const numCh = pcmData.channels.length;

      let playbackChannels: Float32Array[];
      if (listenNormalized) {
        const computed = computeTrackGain(
          track.analysis,
          settings,
          track.manualGainOverrideDb,
          track.format === 'mp3'
        );
        const ceilingDb =
          settings.targetMode === 'peak'
            ? settings.targetPeakDb
            : settings.lufsPeakCeilingDb;
        const useLimiter =
          settings.engineMode === 'exact' && settings.clipProtection === 'limiter';

        const { processed } = processPcmWithGainAndLimiter(
          pcmData.channels,
          sr,
          computed.appliedGainDb,
          ceilingDb,
          useLimiter
        );
        playbackChannels = processed;
      } else {
        playbackChannels = pcmData.channels;
      }

      const audioBuf = ctx.createBuffer(numCh, len, sr);
      for (let c = 0; c < numCh; c++) {
        audioBuf.copyToChannel(new Float32Array(playbackChannels[c]), c);
      }

      // Final session check right before starting audio output
      if (playSessionRef.current !== mySession) return;

      const src = ctx.createBufferSource();
      src.buffer = audioBuf;
      src.connect(ctx.destination);

      const safeOffset = Math.max(
        0,
        Math.min(offsetSec, Math.max(0, audioBuf.duration - 0.05))
      );
      const when = ctx.currentTime + 0.01;
      startCtxTimeRef.current = when;
      startOffsetRef.current = safeOffset;
      activeDurationRef.current = audioBuf.duration;

      src.onended = () => {
        // Only treat as natural end if this source is still the active session
        if (playSessionRef.current !== mySession) return;
        stopActiveSource();
        setIsPlaying(false);
        setPositions((prev) => ({ ...prev, [track.id]: 0 }));
      };

      activeSourceRef.current = src;
      src.start(when, safeOffset);

      const tick = () => {
        if (playSessionRef.current !== mySession || !audioCtxRef.current || !activeSourceRef.current) {
          return;
        }
        const elapsed =
          startOffsetRef.current +
          Math.max(0, audioCtxRef.current.currentTime - startCtxTimeRef.current);
        const clamped = Math.min(activeDurationRef.current, elapsed);
        setPositions((prev) => ({ ...prev, [track.id]: clamped }));
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    },
    [ensurePcmForTrack, settings, stopActiveSource]
  );

  // Refresh active playback smoothly only when gain/engine settings change while playing
  const activeTrack = tracks.find((t) => t.id === activeTrackId) ?? null;
  const activeGainSignature = activeTrack?.analysis
    ? `${activeTrack.manualGainOverrideDb ?? 'auto'}-${settings.targetMode}-${settings.targetPeakDb}-${settings.targetLufs}-${settings.lufsPeakCeilingDb}-${settings.engineMode}-${settings.clipProtection}`
    : '';
  const prevSigRef = useRef<string>('');

  useEffect(() => {
    if (!activeTrack) {
      prevSigRef.current = '';
      return;
    }
    if (prevSigRef.current === activeGainSignature) return;
    const hadPrev = prevSigRef.current !== '';
    prevSigRef.current = activeGainSignature;

    if (!hadPrev || !isPlaying || !activeTrack.analysis) return;
    const isNorm = normalizedByTrack[activeTrack.id] ?? true;
    if (!isNorm) return;

    const currentPos = getCurrentElapsed(
      positions[activeTrack.id] ?? 0,
      activeTrack.analysis.durationSeconds
    );
    void startSingleSourceAtOffset(activeTrack, currentPos, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeGainSignature]);

  // Stop playback & prune cache if active track is removed
  useEffect(() => {
    const validIds = new Set(tracks.map((t) => t.id));
    for (const key of pcmCacheRef.current.keys()) {
      if (!validIds.has(key)) pcmCacheRef.current.delete(key);
    }
    if (activeTrackId && !validIds.has(activeTrackId)) {
      playSessionRef.current++;
      stopActiveSource();
      setIsPlaying(false);
      setActiveTrackId(null);
    }
  }, [tracks, activeTrackId, stopActiveSource]);

  useEffect(() => {
    return () => {
      playSessionRef.current++;
      stopActiveSource();
      if (audioCtxRef.current) {
        void audioCtxRef.current.close();
        audioCtxRef.current = null;
      }
    };
  }, [stopActiveSource]);

  const togglePlay = useCallback(
    (track: TrackItem) => {
      if (!track.analysis) return;
      const isNorm = normalizedByTrack[track.id] ?? true;

      if (activeTrackId === track.id && isPlaying) {
        // Pause current track cleanly
        const elapsed = getCurrentElapsed(
          positions[track.id] ?? 0,
          track.analysis.durationSeconds
        );
        playSessionRef.current++;
        stopActiveSource();
        setPositions((prev) => ({ ...prev, [track.id]: elapsed }));
        setIsPlaying(false);
        return;
      }

      // If another track was playing, save its position and stop it immediately before starting new track
      if (activeTrackId && activeTrackId !== track.id && isPlaying) {
        const prevTrack = tracks.find((t) => t.id === activeTrackId);
        if (prevTrack?.analysis) {
          const prevElapsed = getCurrentElapsed(
            positions[activeTrackId] ?? 0,
            prevTrack.analysis.durationSeconds
          );
          setPositions((prev) => ({ ...prev, [activeTrackId]: prevElapsed }));
        }
      }

      const startAt = positions[track.id] ?? 0;
      prevSigRef.current = `${track.manualGainOverrideDb ?? 'auto'}-${settings.targetMode}-${settings.targetPeakDb}-${settings.targetLufs}-${settings.lufsPeakCeilingDb}-${settings.engineMode}-${settings.clipProtection}`;
      setActiveTrackId(track.id);
      setIsPlaying(true);
      void startSingleSourceAtOffset(track, startAt, isNorm);
    },
    [
      activeTrackId,
      getCurrentElapsed,
      isPlaying,
      normalizedByTrack,
      positions,
      settings,
      startSingleSourceAtOffset,
      stopActiveSource,
      tracks,
    ]
  );

  const toggleNormalizePreview = useCallback(
    (trackId: string) => {
      const current = normalizedByTrack[trackId] ?? true;
      const next = !current;
      setNormalizedByTrack((prev) => ({ ...prev, [trackId]: next }));

      if (activeTrackId === trackId && isPlaying) {
        const track = tracks.find((t) => t.id === trackId);
        if (track?.analysis) {
          const pos = getCurrentElapsed(
            positions[trackId] ?? 0,
            track.analysis.durationSeconds
          );
          void startSingleSourceAtOffset(track, pos, next);
        }
      }
    },
    [
      activeTrackId,
      getCurrentElapsed,
      isPlaying,
      normalizedByTrack,
      positions,
      startSingleSourceAtOffset,
      tracks,
    ]
  );

  const seekTrack = useCallback(
    (track: TrackItem, timeSec: number) => {
      if (!track.analysis) return;
      const clamped = Math.max(
        0,
        Math.min(track.analysis.durationSeconds, timeSec)
      );
      setPositions((prev) => ({ ...prev, [track.id]: clamped }));

      if (activeTrackId === track.id && isPlaying) {
        const isNorm = normalizedByTrack[track.id] ?? true;
        void startSingleSourceAtOffset(track, clamped, isNorm);
      }
    },
    [activeTrackId, isPlaying, normalizedByTrack, startSingleSourceAtOffset]
  );

  return {
    activeTrackId,
    isPlaying,
    positions,
    normalizedByTrack,
    togglePlay,
    toggleNormalizePreview,
    seekTrack,
  };
}
