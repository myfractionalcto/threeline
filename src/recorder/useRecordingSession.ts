import { useCallback, useEffect, useRef, useState } from 'react';
import { platform } from '@/platform';
import type { ProjectHandle, ProjectManifest, TrackKind } from '@/platform';

/**
 * Owns the MediaRecorder lifecycle for the three laptop tracks: screen,
 * laptop-cam, laptop-mic. Each is recorded independently and streamed to
 * the platform adapter a chunk at a time.
 *
 * Design rule (plan §3.1): every input is its own file. No pre-compositing
 * at record time — layout choices happen later in the editor.
 */

export type SessionState = 'idle' | 'preparing' | 'recording' | 'saving' | 'saved' | 'error';

interface TrackRuntime {
  kind: TrackKind;
  stream: MediaStream;
  recorder: MediaRecorder;
  mimeType: string;
  startedAtMs: number;
  bytes: number;
  /** Queue of pending IPC writes — awaited during stop to guarantee flush. */
  inflight: Promise<unknown>[];
}

interface StartOptions {
  screenStream: MediaStream | null;
  /** desktopCapturer source id for the chosen screen — needed so the
   *  cursor tracker picks the right display on multi-monitor setups. */
  screenSourceId: string | null;
  camStream: MediaStream | null;
  micStream: MediaStream | null;
}

/**
 * Probe for the best container/codec combo the current browser supports.
 * VP9 on Chrome/Android; H.264 on iOS Safari (relevant for the PWA, not
 * the laptop — but the laptop runs Chromium so VP9 always wins here).
 */
function pickMime(kind: 'video' | 'audio'): string {
  const candidates =
    kind === 'video'
      ? [
          'video/webm;codecs=vp9,opus',
          'video/webm;codecs=vp9',
          'video/webm;codecs=vp8,opus',
          'video/webm',
          'video/mp4;codecs=h264',
        ]
      : [
          'audio/webm;codecs=opus',
          'audio/webm',
          'audio/mp4',
        ];
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c;
  }
  throw new Error(`no supported MediaRecorder mime for ${kind}`);
}

interface UseRecordingSessionOptions {
  /** Called at start+stop to figure out which phones should participate. */
  getReadyCompanionIds?: () => string[];
  /** Read at finalize time so the user can edit the name right up until save. */
  getProjectName?: () => string;
}

export function useRecordingSession(opts: UseRecordingSessionOptions = {}) {
  const [state, setState] = useState<SessionState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [project, setProject] = useState<ProjectHandle | null>(null);
  const participatingIdsRef = useRef<string[]>([]);
  // Keep `opts` in a ref so callbacks read current values, not the ones
  // captured when `start`/`stop` were first memoized — otherwise phones
  // that connect AFTER this hook mounted would be invisible to the
  // recording session.
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const tracksRef = useRef<TrackRuntime[]>([]);
  const startedAtRef = useRef<number>(0);
  const tickRef = useRef<number | null>(null);

  /** Stop the ticker, leave track streams alone (caller decides). */
  const stopTicker = useCallback(() => {
    if (tickRef.current !== null) {
      window.clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }, []);

  const buildTrack = useCallback(
    (
      projectId: string,
      kind: TrackKind,
      stream: MediaStream,
      hasAudio: boolean,
    ): TrackRuntime => {
      const mimeType = pickMime(hasAudio ? 'video' : kind === 'laptop-mic' ? 'audio' : 'video');
      // Note: laptop-mic is audio-only, others are video-only per plan §4.1.
      const rec = new MediaRecorder(stream, { mimeType });
      const runtime: TrackRuntime = {
        kind,
        stream,
        recorder: rec,
        mimeType,
        startedAtMs: 0,
        bytes: 0,
        inflight: [],
      };

      rec.ondataavailable = async (event: BlobEvent) => {
        if (!event.data || event.data.size === 0) return;
        const ab = await event.data.arrayBuffer();
        runtime.bytes += ab.byteLength;
        const p = platform.writeTrackChunk(projectId, kind, mimeType, ab);
        runtime.inflight.push(p);
        // Don't let inflight grow unbounded if writes are fast.
        p.finally(() => {
          const i = runtime.inflight.indexOf(p);
          if (i >= 0) runtime.inflight.splice(i, 1);
        });
      };

      rec.onerror = (e) => {
        console.error(`recorder error on ${kind}`, e);
        setError(`Recorder error on ${kind}`);
      };

      return runtime;
    },
    [],
  );

  const start = useCallback(
    async ({ screenStream, screenSourceId, camStream, micStream }: StartOptions) => {
      setError(null);
      setState('preparing');
      try {
        const handle = await platform.startProject();
        setProject(handle);

        const list: TrackRuntime[] = [];
        if (screenStream) list.push(buildTrack(handle.id, 'screen', screenStream, false));
        if (camStream) list.push(buildTrack(handle.id, 'laptop-cam', camStream, false));
        // laptop-cam is video-only; mic is always a separate track.
        if (micStream) list.push(buildTrack(handle.id, 'laptop-mic', micStream, true));

        if (list.length === 0) throw new Error('no inputs selected');

        // Give companion phones a ~500ms pre-roll so their MediaRecorder
        // has a chance to actually start at the laptop's startAt instant.
        // We broadcast `startAt = now + 500ms`, then our own recorders
        // start at that same moment.
        const companionIds = optsRef.current.getReadyCompanionIds?.() ?? [];
        participatingIdsRef.current = companionIds;
        const preRollMs = companionIds.length > 0 ? 500 : 0;
        const startAt = Date.now() + preRollMs;
        if (companionIds.length > 0) {
          // Tell phones which project to upload into + broadcast start.
          await platform.companionSetCurrentProject(handle.id).catch(() => {});
          await platform
            .companionBroadcastStart(startAt, handle.id)
            .catch((e) => console.warn('companion start broadcast failed', e));
        }

        if (preRollMs > 0) {
          await new Promise((r) => setTimeout(r, preRollMs));
        }

        startedAtRef.current = startAt;
        for (const t of list) {
          t.startedAtMs = startAt;
          t.recorder.start(1000); // 1 s chunks
        }

        // Kick off cursor tracking in parallel. No-op on web.
        if (screenStream) {
          platform
            .startCursorTracking(handle.id, startAt, screenSourceId)
            .catch((e) => console.warn('cursor tracking failed to start', e));
        }

        tracksRef.current = list;
        setElapsedMs(0);
        tickRef.current = window.setInterval(() => {
          setElapsedMs(Date.now() - startAt);
        }, 250);
        setState('recording');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        setState('error');
      }
    },
    [buildTrack],
  );

  const stop = useCallback(async () => {
    if (state !== 'recording') return;
    setState('saving');
    stopTicker();

    const tracks = tracksRef.current;
    const handle = project;
    if (!handle) return;

    try {
      // Tell phones to stop & upload in parallel with the laptop's own
      // finalize work — upload happens over the network while we're
      // flushing local tracks.
      const companionIds = participatingIdsRef.current;
      // Register the upload-wait BEFORE broadcasting stop so the
      // listener is in place even if the phone uploads before we get to
      // the await below.
      const uploadsPromise: Promise<{ id: string; file: string }[]> =
        companionIds.length > 0
          ? platform.companionWaitForUploads(companionIds).catch((e) => {
              console.warn('companion upload wait failed', e);
              return [];
            })
          : Promise.resolve([]);
      if (companionIds.length > 0) {
        platform.companionBroadcastStop().catch(() => {});
      }

      // Stop cursor tracking first so it gets the full recording window.
      // No-op on web; Electron flushes cursor.jsonl.
      const cursorFile = await platform
        .stopCursorTracking(handle.id)
        .catch((e) => {
          console.warn('cursor tracking failed to stop', e);
          return null;
        });

      // Ask every recorder to stop — ondataavailable fires one last time.
      await Promise.all(
        tracks.map(
          (t) =>
            new Promise<void>((resolve) => {
              if (t.recorder.state === 'inactive') return resolve();
              t.recorder.onstop = () => resolve();
              t.recorder.stop();
            }),
        ),
      );

      // Wait for any inflight chunk writes to hit disk.
      await Promise.all(tracks.flatMap((t) => t.inflight));

      // Stop device streams.
      for (const t of tracks) {
        for (const track of t.stream.getTracks()) track.stop();
      }

      const endAt = Date.now();
      const rawName = optsRef.current.getProjectName?.()?.trim();
      const manifest: ProjectManifest & { cursorTrack?: { file: string } } = {
        id: handle.id,
        name: rawName && rawName.length > 0 ? rawName : undefined,
        createdAtMs: startedAtRef.current,
        canvas: { width: 1080, height: 1920, orientation: 'portrait' },
        tracks: [],
      };
      if (cursorFile) {
        manifest.cursorTrack = { file: cursorFile };
      }

      for (const t of tracks) {
        const file = await platform.finalizeTrack(handle.id, t.kind);
        manifest.tracks.push({
          id: t.kind,
          mimeType: t.mimeType,
          startedAtMs: t.startedAtMs,
          durationMs: endAt - t.startedAtMs,
          bytes: t.bytes,
          file,
        });
      }

      // Wait for any phones to finish uploading before writing the manifest.
      // The wait was kicked off above so we don't race the upload.
      if (companionIds.length > 0) {
        const uploads = await uploadsPromise;
        for (const up of uploads) {
          manifest.tracks.push({
            id: 'mobile-cam',
            mimeType: 'video/webm',
            startedAtMs: startedAtRef.current,
            durationMs: endAt - startedAtRef.current,
            bytes: 0,
            file: up.file,
          });
        }
      }

      await platform.finalizeProject(handle.id, manifest);
      tracksRef.current = [];
      setState('saved');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setState('error');
    }
  }, [project, state, stopTicker]);

  useEffect(
    () => () => {
      stopTicker();
      for (const t of tracksRef.current) {
        for (const track of t.stream.getTracks()) track.stop();
      }
    },
    [stopTicker],
  );

  return { state, error, elapsedMs, project, start, stop };
}
