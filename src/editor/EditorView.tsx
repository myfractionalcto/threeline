import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Download, Loader2 } from 'lucide-react';
import { platform } from '@/platform';
import type { TrackKind } from '@/platform';
import { cn } from '@/lib/utils';
import {
  defaultAudioSource,
  defaultLayout,
  defaultSecondarySource,
  useEditorState,
} from './useEditorState';
import { usePlayback } from './usePlayback';
import { Preview, type PreviewHandle } from './Preview';
import { Timeline } from './Timeline';
import { Inspector } from './Inspector';
import { TrackPool } from './TrackPool';
import {
  CANVAS_PRESETS,
  DEFAULT_CAM_TRANSFORM,
  DEFAULT_TRANSFORM,
  genSceneId,
  type EditorProject,
  type EditorTrack,
  type SourceTransform,
} from './types';

interface Props {
  projectId: string | null;
  onExit: () => void;
}

type ExportState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'done'; path: string }
  | { kind: 'error'; message: string };

/**
 * Thin shell that owns the project, wires playback into the timeline, and
 * delegates rendering to Preview + Inspector + Timeline.
 */
export function EditorView({ projectId, onExit }: Props) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const editor = useEditorState(null);
  const playback = usePlayback(editor.project);
  const previewRef = useRef<PreviewHandle>(null);
  const [exportState, setExportState] = useState<ExportState>({ kind: 'idle' });

  const loadFromPlatform = useCallback(async () => {
    setLoadError(null);
    setLoading(true);
    try {
      const loaded = await platform.openProject(projectId ?? undefined);
      if (!loaded) {
        setLoading(false);
        return;
      }
      editor.setProject(buildProject(loaded));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [editor, projectId]);

  useEffect(() => {
    loadFromPlatform();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // As each <video>/<audio> reports its duration, widen the project's total.
  // (The manifest has a duration, but trust the actual file on load.)
  const onDurationKnown = useCallback(
    (kind: TrackKind, durationMs: number) => {
      editor.setProject((p) => {
        if (!p) return p;
        const tracks = p.tracks.map((t) =>
          t.kind === kind ? { ...t, durationMs } : t,
        );
        const totalDurationMs = computeTotal(tracks, p.sessionStartMs);
        // Extend the last scene if it ended at the old total.
        const scenes = extendTrailingSceneToTotal(p.scenes, totalDurationMs);
        return { ...p, tracks, totalDurationMs, scenes };
      });
    },
    [editor],
  );

  // Find the scene containing the playhead.
  const activeScene = editor.project
    ? editor.project.scenes.find(
        (s) => playback.playheadMs >= s.start && playback.playheadMs < s.end,
      ) ?? editor.project.scenes[editor.project.scenes.length - 1]
    : null;

  // Preview must follow the playhead during playback so layout swaps happen
  // at scene boundaries. When paused, defer to the user's selection so
  // inspecting a scene shows that scene's layout in the preview.
  const previewScene = playback.playing ? activeScene : editor.selectedScene ?? activeScene;
  // Inspector always follows the user's explicit selection, or the active
  // scene if nothing is selected.
  const inspectorScene = editor.selectedScene ?? activeScene;

  const splitAtPlayhead = useCallback(() => {
    editor.splitAt(playback.playheadMs);
  }, [editor, playback.playheadMs]);

  /**
   * Keyboard-driven removal. Priority: selected trim clip → selected
   * zoom clip → selected scene. Trim and zoom selections are mutually
   * exclusive in state, so the order only matters when neither is set
   * and we fall through to scene delete (pre-Phase-2 behavior).
   */
  const handleDeleteSelection = useCallback(() => {
    if (editor.selectedTrimClip && editor.selectedSceneId) {
      editor.removeTrimClip(editor.selectedSceneId, editor.selectedTrimClip.id);
      return;
    }
    if (editor.selectedZoomClip && editor.selectedSceneId) {
      editor.removeZoomClip(editor.selectedSceneId, editor.selectedZoomClip.id);
      return;
    }
    if (editor.selectedSceneId) {
      editor.deleteScene(editor.selectedSceneId);
    }
  }, [editor]);

  // Keyboard shortcuts:
  //   Space                → play/pause
  //   Shift + ←/→          → seek ±1s
  //   Shift + ⌘/Ctrl + ←/→ → seek ±5s (big step)
  //   ⌘/Ctrl + L           → split scene at playhead
  //
  // Bound at window level so the user doesn't have to click the canvas
  // first. We skip when focus is in a text field so typing a project name
  // or transform value doesn't silently control playback.
  useEffect(() => {
    const isTextTarget = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      if (!el) return false;
      if (el.isContentEditable) return true;
      const tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    };
    const handler = (e: KeyboardEvent) => {
      if (isTextTarget(e.target)) return;
      const mod = e.metaKey || e.ctrlKey;
      // Space: toggle. No modifiers; preventDefault so the page doesn't scroll.
      if (e.code === 'Space' && !mod && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        playback.toggle();
        return;
      }
      // ⌘L: split at playhead. preventDefault stops Electron / Chrome's
      // default "focus location bar" shortcut.
      if (mod && !e.altKey && !e.shiftKey && (e.key === 'l' || e.key === 'L')) {
        e.preventDefault();
        splitAtPlayhead();
        return;
      }
      // Shift+←/→: seek ±1s. Adding ⌘/Ctrl bumps the step to ±5s so heavy
      // scrubbing is cheap. Plain arrows are left alone so they still move
      // focus/selection in the surrounding UI.
      if (e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        const stepMs = mod ? 5000 : 1000;
        const dir = e.key === 'ArrowLeft' ? -1 : 1;
        playback.seek(playback.playheadMs + dir * stepMs);
        return;
      }
      // Escape: clear zoom- or trim-clip selection so the Inspector
      // falls back to scene-level properties. Cheap to always run —
      // no-ops when nothing is selected.
      if (e.key === 'Escape' && !mod && !e.shiftKey && !e.altKey) {
        editor.clearZoomClipSelection();
        editor.clearTrimClipSelection();
        return;
      }
      // Delete/Backspace: remove the active selection (clip first, then
      // scene). Only when no modifiers so ⌘Backspace in a text field is
      // unaffected, and we already bailed above on text targets anyway.
      if ((e.key === 'Delete' || e.key === 'Backspace') && !mod && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        handleDeleteSelection();
        return;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [editor, handleDeleteSelection, playback, splitAtPlayhead]);

  const startExport = useCallback(async () => {
    if (!editor.project) return;
    setExportState({ kind: 'running' });
    try {
      const req = buildExportRequest(editor.project);
      const res = await platform.exportProject(req);
      if ('cancelled' in res && res.cancelled) {
        setExportState({ kind: 'idle' });
        return;
      }
      setExportState({ kind: 'done', path: res.outputPath });
    } catch (e) {
      setExportState({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, [editor.project]);

  if (loading) {
    return (
      <LoadingShell onExit={onExit}>
        <Loader2 className="size-6 animate-spin" />
        <div>Loading project…</div>
      </LoadingShell>
    );
  }

  if (loadError) {
    return (
      <LoadingShell onExit={onExit}>
        <div className="text-destructive-foreground">{loadError}</div>
        <button
          type="button"
          onClick={loadFromPlatform}
          className="text-sm px-3 py-1.5 rounded-md border border-border hover:border-foreground/40"
        >
          Retry
        </button>
      </LoadingShell>
    );
  }

  if (!editor.project) {
    return (
      <LoadingShell onExit={onExit}>
        <div>No project loaded.</div>
        <button
          type="button"
          onClick={loadFromPlatform}
          className="text-sm px-3 py-1.5 rounded-md border border-border hover:border-foreground/40"
        >
          Open project
        </button>
      </LoadingShell>
    );
  }

  return (
    <main className="h-screen flex flex-col bg-background overflow-hidden">
      <header
        className={cn(
          'py-3 flex items-center gap-4 border-b border-border/60 shrink-0',
          // On macOS the window uses titleBarStyle: 'hiddenInset', so the
          // traffic lights float over the top-left corner. Push content
          // past them when we're running inside Electron.
          platform.kind === 'electron' ? 'pl-[84px] pr-5' : 'px-5',
        )}
      >
        <button
          type="button"
          onClick={onExit}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Home
        </button>
        <div className="h-5 w-px bg-border/60" />
        <div className="flex items-center gap-3 min-w-0">
          <div className="font-medium text-sm truncate">
            {editor.project.name || 'Editor'}
          </div>
          <div className="text-xs text-muted-foreground font-mono truncate max-w-[28rem] hidden md:block">
            {editor.project.location}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-3">
          {exportState.kind === 'done' && (
            <span className="text-xs text-green-400">
              Saved → {exportState.path}
            </span>
          )}
          {exportState.kind === 'error' && (
            <span className="text-xs text-red-400 max-w-sm truncate" title={exportState.message}>
              {exportState.message}
            </span>
          )}
          <button
            type="button"
            onClick={startExport}
            disabled={exportState.kind === 'running' || platform.kind === 'web'}
            title={
              platform.kind === 'web'
                ? 'MP4 export is only available in the desktop app'
                : undefined
            }
            className={cn(
              'flex items-center gap-2 px-3 py-1.5 rounded-md text-sm',
              'bg-primary text-primary-foreground hover:opacity-90',
              'disabled:opacity-50 disabled:cursor-not-allowed',
            )}
          >
            {exportState.kind === 'running' ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Download className="size-4" />
            )}
            Export MP4
          </button>
        </div>
      </header>

      <div className="flex-1 flex min-h-0 min-w-0">
        <div className="flex-1 flex flex-col p-5 gap-4 min-h-0 min-w-0">
          <Preview
            ref={previewRef}
            project={editor.project}
            scene={previewScene ?? null}
            mediaRef={playback.mediaRef}
            playing={playback.playing}
            playheadMs={playback.playheadMs}
            onPan={(role, patch) => {
              const target = inspectorScene ?? previewScene;
              if (target) editor.updateSceneTransform(target.id, role, patch);
            }}
          />
        </div>
        <Inspector
          project={editor.project}
          scene={inspectorScene ?? null}
          selectedZoomClip={editor.selectedZoomClip}
          onLayoutChange={(l) => inspectorScene && editor.setSceneLayout(inspectorScene.id, l)}
          onAudioSourceChange={(a) =>
            inspectorScene && editor.setSceneAudioSource(inspectorScene.id, a)
          }
          onBubbleChange={(c) =>
            inspectorScene && editor.setSceneBubble(inspectorScene.id, c)
          }
          onSecondarySourceChange={(src) =>
            inspectorScene && editor.setSceneSecondarySource(inspectorScene.id, src)
          }
          onCanvasChange={editor.setCanvas}
          onTransformChange={(role, patch) =>
            inspectorScene && editor.updateSceneTransform(inspectorScene.id, role, patch)
          }
          onTransformReset={(role) =>
            inspectorScene && editor.resetSceneTransform(inspectorScene.id, role)
          }
          onShowCursorOverlayChange={editor.setShowCursorOverlay}
          onSceneFollowCursorChange={(follow) => {
            if (inspectorScene)
              editor.setSceneFollowCursor(inspectorScene.id, follow);
          }}
          onUpdateZoomClip={(clipId, patch) => {
            if (inspectorScene) editor.updateZoomClip(inspectorScene.id, clipId, patch);
          }}
          onRemoveZoomClip={(clipId) => {
            if (inspectorScene) editor.removeZoomClip(inspectorScene.id, clipId);
          }}
          onClearZoomClipSelection={editor.clearZoomClipSelection}
        />
      </div>

      <Timeline
        project={editor.project}
        playheadMs={playback.playheadMs}
        playing={playback.playing}
        selectedSceneId={editor.selectedSceneId}
        selectedZoomClipId={editor.selectedZoomClipId}
        selectedTrimClipId={editor.selectedTrimClipId}
        onSeek={playback.seek}
        onTogglePlay={playback.toggle}
        onSelectScene={editor.setSelectedSceneId}
        onSelectZoomClip={editor.selectZoomClip}
        onClearZoomClipSelection={editor.clearZoomClipSelection}
        onSelectTrimClip={editor.selectTrimClip}
        onClearTrimClipSelection={editor.clearTrimClipSelection}
        onUpdateZoomClip={editor.updateZoomClip}
        onUpdateTrimClip={editor.updateTrimClip}
        onAddZoomClip={editor.addZoomClip}
        onAddTrimClip={editor.addTrimClip}
        onSplitAtPlayhead={splitAtPlayhead}
        onDeleteScene={editor.deleteScene}
      />

      {/* Hidden media pool — one element per track. */}
      {/* Audio tracks the preview scene, so the source swaps at scene
          boundaries during playback. */}
      <TrackPool
        tracks={editor.project.tracks}
        sceneAudioSource={previewScene?.audioSource ?? null}
        onMediaReady={playback.registerMedia}
        onDurationKnown={onDurationKnown}
      />
    </main>
  );
}

function LoadingShell({
  children,
  onExit,
}: {
  children: React.ReactNode;
  onExit: () => void;
}) {
  return (
    <main className="min-h-screen flex flex-col bg-background">
      <header className="px-5 py-3 flex items-center gap-4 border-b border-border/60">
        <button
          type="button"
          onClick={onExit}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" /> Home
        </button>
      </header>
      <div className="flex-1 flex flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        {children}
      </div>
    </main>
  );
}

/**
 * Bridge from the platform-agnostic loaded project to the editor's richer
 * state shape. Adds render-only fields and a single full-length scene to
 * seed editing.
 */
function buildProject(loaded: {
  manifest: {
    id: string;
    name?: string;
    createdAtMs: number;
    canvas: { orientation: string };
    tracks: unknown[];
  };
  trackUrls: Record<string, string>;
  location: string;
  cursorTrack?: EditorProject['cursorTrack'];
}): EditorProject {
  const tracks: EditorTrack[] = loaded.manifest.tracks.map((raw) => {
    const t = raw as {
      id: TrackKind;
      mimeType: string;
      startedAtMs: number;
      durationMs: number;
    };
    const url = loaded.trackUrls[t.id] ?? '';
    const hasVideo = t.mimeType.startsWith('video/');
    // Mobile recordings bundle video + audio into a single WebM/MP4 track,
    // unlike the laptop capture where mic is split out.
    const hasAudio =
      t.mimeType.startsWith('audio/') || t.id === 'laptop-mic' || t.id === 'mobile-cam';
    return {
      id: t.id,
      kind: t.id,
      url,
      mimeType: t.mimeType,
      startedAtMs: t.startedAtMs,
      durationMs: t.durationMs,
      hasVideo,
      hasAudio,
    };
  });

  const sessionStartMs = tracks.reduce(
    (acc, t) => Math.min(acc, t.startedAtMs),
    tracks[0]?.startedAtMs ?? 0,
  );
  const totalDurationMs = computeTotal(tracks, sessionStartMs);

  const layout = defaultLayout(tracks.map((t) => ({ kind: t.kind, hasVideo: t.hasVideo })));
  const secondarySource = defaultSecondarySource(
    tracks.map((t) => ({ kind: t.kind, hasVideo: t.hasVideo })),
  );
  const audio = defaultAudioSource(tracks.map((t) => ({ kind: t.kind, hasAudio: t.hasAudio })));

  const orientation = (loaded.manifest.canvas?.orientation as 'portrait' | 'landscape' | 'square') ?? 'portrait';

  // Seed a screen-transform that actually looks good out of the box when
  // a landscape screen drops into a portrait canvas: fill-fit so the user
  // isn't greeted by giant black bars on the first open.
  const canvas = CANVAS_PRESETS[orientation] ?? CANVAS_PRESETS.portrait;
  const screenTrack = tracks.find((t) => t.kind === 'screen');
  const screenTransform = initialScreenTransform(canvas, screenTrack);

  return {
    id: loaded.manifest.id,
    name: loaded.manifest.name,
    location: loaded.location,
    createdAtMs: loaded.manifest.createdAtMs,
    canvas,
    tracks,
    scenes: [
      {
        id: genSceneId(),
        start: 0,
        end: totalDurationMs,
        layout,
        bubbleCorner: 'br',
        secondarySource,
        audioSource: audio,
        screenTransform,
        camTransform: { ...DEFAULT_CAM_TRANSFORM },
        // Default on when we have cursor data — most users want follow in
        // cropped layouts without having to find the toggle.
        followCursor: !!loaded.cursorTrack,
        zoomClips: [],
        trimClips: [],
      },
    ],
    sessionStartMs,
    totalDurationMs,
    cursorTrack: loaded.cursorTrack,
    showCursorOverlay: false,
  };
}

/**
 * Pick a reasonable default framing for the screen source: if the source's
 * aspect differs strongly from the canvas's, start with fill-fit so the
 * user sees something filling the frame and can then pan. Same aspect:
 * contain (the natural "1:1 pixels" look).
 */
function initialScreenTransform(
  canvas: { width: number; height: number },
  screen: EditorTrack | undefined,
): SourceTransform {
  const canvasAr = canvas.width / canvas.height;
  // We don't know the source resolution until the media element loads,
  // but the cam-vs-screen mismatch is almost always landscape-source +
  // portrait-canvas, which is what we optimize for.
  if (!screen) return { ...DEFAULT_TRANSFORM };
  // Portrait canvas + the common landscape screen recording → cover.
  if (canvasAr < 1) return { fit: 'cover', zoom: 1, offsetX: 0, offsetY: 0 };
  return { ...DEFAULT_TRANSFORM };
}

function computeTotal(tracks: EditorTrack[], sessionStartMs: number): number {
  return tracks.reduce((acc, t) => {
    const end = t.startedAtMs + t.durationMs - sessionStartMs;
    return Math.max(acc, end);
  }, 0);
}

function extendTrailingSceneToTotal(
  scenes: EditorProject['scenes'],
  total: number,
): EditorProject['scenes'] {
  if (scenes.length === 0) return scenes;
  const last = scenes[scenes.length - 1];
  if (last.end >= total) return scenes;
  const next = [...scenes];
  next[next.length - 1] = { ...last, end: total };
  return next;
}

function buildExportRequest(p: EditorProject) {
  return {
    projectId: p.id,
    projectName: p.name,
    canvas: { width: p.canvas.width, height: p.canvas.height },
    orientation: p.canvas.orientation,
    scenes: p.scenes.map((s) => ({
      id: s.id,
      start: s.start,
      end: s.end,
      layout: s.layout,
      bubbleCorner: s.bubbleCorner,
      secondarySource: s.secondarySource,
      audioSource: s.audioSource,
      screenTransform: s.screenTransform,
      camTransform: s.camTransform,
      followCursor: s.followCursor,
      // Drop fields ffmpeg doesn't need (id) and sort by time so the
      // exporter can trust the order when segmenting.
      zoomClips: [...s.zoomClips]
        .sort((a, b) => a.start - b.start)
        .map((c) => ({
          start: c.start,
          end: c.end,
          zoom: c.zoom,
          offsetX: c.offsetX,
          offsetY: c.offsetY,
          followCursor: c.followCursor,
        })),
      trimClips: [...s.trimClips]
        .sort((a, b) => a.start - b.start)
        .map((c) => ({ start: c.start, end: c.end })),
    })),
    tracks: p.tracks.map((t) => ({
      id: t.id,
      offsetMs: t.startedAtMs - p.sessionStartMs,
      durationMs: t.durationMs,
      filePath: t.url, // Electron main rewrites this to an absolute path.
      url: t.url,
    })),
    cursorTrack: p.cursorTrack
      ? {
          samples: p.cursorTrack.samples,
          display: p.cursorTrack.display,
        }
      : undefined,
  };
}
