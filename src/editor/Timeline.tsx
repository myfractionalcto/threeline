import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pause, Play, Plus, Scissors, ScissorsSquare, Trash2, ZoomIn } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { EditorProject, Scene, TrimClip, ZoomClip } from './types';
import { useClipDrag } from './useClipDrag';

// Modifier glyph for keyboard-shortcut pills. Mac uses ⌘; everywhere else
// we show "Ctrl+" so the hint matches what the user actually has to press.
// The keybinding handler accepts either metaKey or ctrlKey regardless.
const IS_MAC =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD_KEY = IS_MAC ? '⌘' : 'Ctrl+';

// Default duration for a zoom clip dropped via the timeline "click to add"
// gesture. Matches what the (removed) Inspector button used to seed.
const DEFAULT_ADD_ZOOM_DURATION_MS = 2000;
// Trim clips start wider since users typically cut longer boring
// stretches than they zoom into. Still tweakable via resize handles.
const DEFAULT_ADD_TRIM_DURATION_MS = 3000;

interface Props {
  project: EditorProject;
  playheadMs: number;
  playing: boolean;
  selectedSceneId: string | null;
  selectedZoomClipId: string | null;
  selectedTrimClipId: string | null;
  onSeek: (ms: number) => void;
  onTogglePlay: () => void;
  onSelectScene: (id: string) => void;
  onSelectZoomClip: (sceneId: string, clipId: string) => void;
  onClearZoomClipSelection: () => void;
  onSelectTrimClip: (sceneId: string, clipId: string) => void;
  onClearTrimClipSelection: () => void;
  onUpdateZoomClip: (sceneId: string, clipId: string, patch: Partial<ZoomClip>) => void;
  onUpdateTrimClip: (sceneId: string, clipId: string, patch: Partial<TrimClip>) => void;
  onAddZoomClip: (sceneId: string, start: number, end: number) => void;
  onAddTrimClip: (sceneId: string, start: number, end: number) => void;
  onSplitAtPlayhead: () => void;
  onDeleteScene: (id: string) => void;
}

export function Timeline({
  project,
  playheadMs,
  playing,
  selectedSceneId,
  selectedZoomClipId,
  selectedTrimClipId,
  onSeek,
  onTogglePlay,
  onSelectScene,
  onSelectZoomClip,
  onClearZoomClipSelection,
  onSelectTrimClip,
  onClearTrimClipSelection,
  onUpdateZoomClip,
  onUpdateTrimClip,
  onAddZoomClip,
  onAddTrimClip,
  onSplitAtPlayhead,
  onDeleteScene,
}: Props) {
  // Single ruler-ref drives both scrub math and zoom-clip drag math. All
  // lanes below share this ref so % → ms conversion is consistent.
  const rulerRef = useRef<HTMLDivElement>(null);

  const totalMs = project.totalDurationMs;

  const toPct = useCallback(
    (ms: number) => (totalMs > 0 ? (ms / totalMs) * 100 : 0),
    [totalMs],
  );

  const { startDrag } = useClipDrag({
    rulerRef,
    totalMs,
    onUpdateZoom: onUpdateZoomClip,
    onUpdateTrim: onUpdateTrimClip,
  });

  const handleSeekFromEvent = useCallback(
    (e: React.MouseEvent | MouseEvent) => {
      const el = rulerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
      const pct = x / rect.width;
      onSeek(pct * totalMs);
    },
    [onSeek, totalMs],
  );

  // Drag-to-scrub on the top ruler only. The lanes below handle their
  // own clicks; we don't want clicking a zoom clip to also scrub.
  useEffect(() => {
    const el = rulerRef.current;
    if (!el) return;
    let down = false;
    const handleDown = (e: MouseEvent) => {
      if (e.target !== el && !el.contains(e.target as Node)) return;
      down = true;
      onClearZoomClipSelection();
      onClearTrimClipSelection();
      handleSeekFromEvent(e);
    };
    const handleMove = (e: MouseEvent) => {
      if (down) handleSeekFromEvent(e);
    };
    const handleUp = () => {
      down = false;
    };
    el.addEventListener('mousedown', handleDown);
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      el.removeEventListener('mousedown', handleDown);
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [handleSeekFromEvent, onClearZoomClipSelection, onClearTrimClipSelection]);

  // Tick marks for the ruler — interval is auto-picked so the labels
  // stay readable regardless of total duration. ~8–12 marks is the sweet
  // spot; we round to a "nice" step (1, 2, 5, 10, 30, 60 seconds).
  const tickStepMs = pickTickStep(totalMs);
  const ticks = useMemo(() => {
    if (totalMs <= 0 || tickStepMs <= 0) return [] as number[];
    const arr: number[] = [];
    for (let t = 0; t <= totalMs; t += tickStepMs) arr.push(t);
    return arr;
  }, [totalMs, tickStepMs]);

  return (
    <div className="border-t border-border/60 bg-card/40 px-4 pt-3 pb-3 space-y-2 shrink-0">
      {/* Transport controls + global actions */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onTogglePlay}
          className="size-9 rounded-full bg-primary text-primary-foreground flex items-center justify-center hover:opacity-90"
        >
          {playing ? (
            <Pause className="size-4 fill-current" />
          ) : (
            <Play className="size-4 fill-current" />
          )}
        </button>
        <div className="font-mono text-sm tabular-nums">
          {fmt(playheadMs)} / {fmt(totalMs)}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={onSplitAtPlayhead}
            title={`Split scene at playhead (${MOD_KEY}L)`}
            className="text-xs px-2 py-1.5 rounded-md border border-border hover:border-foreground/40 flex items-center gap-1.5"
          >
            <Scissors className="size-3.5" />
            Split at playhead
            <kbd className="ml-1 px-1.5 py-0.5 text-[10px] leading-none rounded bg-secondary/60 text-muted-foreground border border-border/60 font-sans">
              {MOD_KEY}L
            </kbd>
          </button>
          <button
            type="button"
            onClick={() => selectedSceneId && onDeleteScene(selectedSceneId)}
            disabled={!selectedSceneId || project.scenes.length <= 1}
            className="text-xs px-2 py-1.5 rounded-md border border-border hover:border-destructive/60 flex items-center gap-1.5 disabled:opacity-40"
          >
            <Trash2 className="size-3.5" />
            Delete split
          </button>
        </div>
      </div>

      {/* Lane grid — ruler on top, one lane per track kind. All lanes
          (including the ruler) sit inside a LaneLabel so their content
          columns share the same horizontal bounds. The playhead is an
          overlay that replicates the label offset — without that the
          ruler's full-width ticks wouldn't line up with the scene /
          zoom / trim blocks below them, which read visually as "split
          is a couple seconds off from where I clicked." */}
      <div className="relative">
        {/* Ruler — shares the same label-column offset as the lanes so
            tick positions align with scene/zoom/trim block positions. */}
        <LaneLabel icon={null} title="">
          <div
            ref={rulerRef}
            className="relative h-7 rounded-md bg-secondary/30 border border-border cursor-pointer select-none"
          >
            {ticks.map((t) => (
              <div
                key={t}
                className="absolute top-0 bottom-0 flex items-end pb-0.5 pointer-events-none"
                style={{ left: `${toPct(t)}%` }}
              >
                <div className="w-px h-2 bg-border mr-1" />
                <span className="text-[10px] font-mono text-muted-foreground leading-none">
                  {fmtShort(t)}
                </span>
              </div>
            ))}
          </div>
        </LaneLabel>

        {/* Scene lane — one row showing the scene blocks. */}
        <LaneLabel icon={null} title="Scenes" className="mt-2">
          <div className="relative h-12 rounded-md bg-secondary/30 border border-border">
            {project.scenes.map((scene, i) => (
              <SceneBlock
                key={scene.id}
                scene={scene}
                index={i}
                selected={scene.id === selectedSceneId && !selectedZoomClipId}
                leftPct={toPct(scene.start)}
                widthPct={toPct(scene.end - scene.start)}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectScene(scene.id);
                }}
              />
            ))}
          </div>
        </LaneLabel>

        {/* Zoom lane — click empty spots to insert a clip. */}
        <LaneLabel
          icon={<ZoomIn className="size-3" />}
          title="Zoom"
          className="mt-1.5"
        >
          <ZoomLane
            project={project}
            selectedZoomClipId={selectedZoomClipId}
            toPct={toPct}
            totalMs={totalMs}
            onSelectZoomClip={onSelectZoomClip}
            onStartDrag={(mode, clip, scene, e) =>
              startDrag('zoom', mode, clip, scene, e)
            }
            onAddZoomClip={onAddZoomClip}
          />
        </LaneLabel>

        {/* Trim lane — click empty spots to mark a cut. Playback and
            export both skip ranges flagged here. */}
        <LaneLabel
          icon={<ScissorsSquare className="size-3" />}
          title="Trim"
          className="mt-1.5"
        >
          <TrimLane
            project={project}
            selectedTrimClipId={selectedTrimClipId}
            toPct={toPct}
            totalMs={totalMs}
            onSelectTrimClip={onSelectTrimClip}
            onStartDrag={(mode, clip, scene, e) =>
              startDrag('trim', mode, clip, scene, e)
            }
            onAddTrimClip={onAddTrimClip}
          />
        </LaneLabel>

        {/* Playhead — absolutely positioned over all lanes. Mirrors the
            LaneLabel flex structure (w-16 spacer + flex-1 content) so
            its % offset is measured against the lane-content region,
            not the full timeline width — otherwise the playhead would
            drift ~72 px right of the scene/zoom/trim blocks it's
            meant to indicate. pointer-events:none so it never eats
            clicks. */}
        <div className="absolute inset-0 flex items-stretch gap-2 pointer-events-none">
          <div className="w-16 shrink-0" />
          <div className="flex-1 min-w-0 relative">
            <div
              className="absolute top-0 bottom-0 w-px bg-red-500"
              style={{ left: `${toPct(playheadMs)}%` }}
            >
              <div className="absolute -top-1 -translate-x-1/2 w-3 h-3 rounded-full bg-red-500" />
            </div>
          </div>
        </div>
      </div>

    </div>
  );
}

/**
 * Wrapper that attaches a small title to the left of a lane. Keeps the
 * lane row layout consistent — label column is a fixed width so the
 * timeline playhead (positioned as % of the lane's width) lines up
 * across lanes.
 */
function LaneLabel({
  icon,
  title,
  className,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn('flex items-stretch gap-2', className)}>
      <div className="w-16 shrink-0 flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground pl-1">
        {icon}
        {title}
      </div>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}

function SceneBlock({
  scene,
  index,
  selected,
  leftPct,
  widthPct,
  onClick,
}: {
  scene: Scene;
  index: number;
  selected: boolean;
  leftPct: number;
  widthPct: number;
  onClick: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseDown={(e) => e.stopPropagation()}
      className={cn(
        'absolute top-1 bottom-1 rounded-md border text-left px-2 py-1 flex flex-col justify-between overflow-hidden transition',
        selected
          ? 'border-foreground/70 bg-foreground/20'
          : 'border-border/60 bg-card hover:border-foreground/40',
      )}
      style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
      title={`${layoutLabel(scene.layout)} — ${fmt(scene.end - scene.start)}`}
    >
      <span className="text-[10px] font-mono uppercase tracking-wide text-muted-foreground truncate">
        #{index + 1}
      </span>
      <span className="text-xs font-medium truncate">{layoutLabel(scene.layout)}</span>
    </button>
  );
}

/**
 * The zoom lane. Renders existing zoom clips as pill-shaped cards, and
 * shows an "add here" ghost at the cursor when hovering empty space. A
 * click on empty space drops a new 2-second clip at that time; clicks
 * on a pill (or its edges) select/drag it instead via the nested
 * handlers below.
 */
function ZoomLane({
  project,
  selectedZoomClipId,
  toPct,
  totalMs,
  onSelectZoomClip,
  onStartDrag,
  onAddZoomClip,
}: {
  project: EditorProject;
  selectedZoomClipId: string | null;
  toPct: (ms: number) => number;
  totalMs: number;
  onSelectZoomClip: (sceneId: string, clipId: string) => void;
  onStartDrag: (
    mode: 'move' | 'resize-l' | 'resize-r',
    clip: ZoomClip,
    scene: Scene,
    e: React.MouseEvent,
  ) => void;
  onAddZoomClip: (sceneId: string, start: number, end: number) => void;
}) {
  const laneRef = useRef<HTMLDivElement>(null);
  const [hoverMs, setHoverMs] = useState<number | null>(null);

  // Map a mouse event to its ms position on the timeline. Returns null
  // for events that miss the lane entirely (shouldn't happen, but the
  // types force us to be defensive).
  const eventToMs = useCallback(
    (e: React.MouseEvent): number | null => {
      const el = laneRef.current;
      if (!el || totalMs <= 0) return null;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0) return null;
      const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
      return (x / rect.width) * totalMs;
    },
    [totalMs],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (e.target !== laneRef.current) {
        // Hovering over a clip — hide the "add here" ghost so it doesn't
        // overlap with the existing clip's own affordances.
        setHoverMs(null);
        return;
      }
      setHoverMs(eventToMs(e));
    },
    [eventToMs],
  );

  const handleMouseLeave = useCallback(() => setHoverMs(null), []);

  const handleLaneMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.target !== laneRef.current) return;
      const ms = eventToMs(e);
      if (ms == null) return;
      // Find which scene this ms falls into — clips belong to a scene.
      const scene = project.scenes.find((s) => ms >= s.start && ms < s.end);
      if (!scene) return;
      // Centre a default-duration clip on the click point, clamped to
      // the scene. addZoomClip handles sibling-overlap trimming.
      const half = DEFAULT_ADD_ZOOM_DURATION_MS / 2;
      const start = Math.max(scene.start, ms - half);
      const end = Math.min(scene.end, start + DEFAULT_ADD_ZOOM_DURATION_MS);
      onAddZoomClip(scene.id, start, end);
      e.preventDefault();
      e.stopPropagation();
    },
    [project.scenes, eventToMs, onAddZoomClip],
  );

  return (
    <div
      ref={laneRef}
      className="relative h-9 rounded-md bg-emerald-950/20 border border-border overflow-hidden cursor-copy"
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onMouseDown={handleLaneMouseDown}
      title="Click on empty space to add a zoom clip"
    >
      {/* Ghost "add here" marker — only shown when hovering empty lane. */}
      {hoverMs != null && (
        <div
          className="absolute top-0 bottom-0 flex items-center pointer-events-none"
          style={{ left: `${toPct(hoverMs)}%` }}
        >
          <div className="w-px bg-emerald-400/60 h-full" />
          <div className="ml-0.5 flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-600/90 text-white text-[10px]">
            <Plus className="size-3" />
            <span>Zoom</span>
          </div>
        </div>
      )}

      {/* Pill cards for each existing zoom clip. */}
      {project.scenes.flatMap((scene) =>
        scene.zoomClips.map((clip) => (
          <ZoomClipCard
            key={clip.id}
            clip={clip}
            selected={clip.id === selectedZoomClipId}
            leftPct={toPct(clip.start)}
            widthPct={toPct(clip.end - clip.start)}
            onClick={(e) => {
              e.stopPropagation();
              onSelectZoomClip(scene.id, clip.id);
            }}
            onBodyMouseDown={(e) => {
              e.stopPropagation();
              onStartDrag('move', clip, scene, e);
            }}
            onLeftMouseDown={(e) => {
              e.stopPropagation();
              onStartDrag('resize-l', clip, scene, e);
            }}
            onRightMouseDown={(e) => {
              e.stopPropagation();
              onStartDrag('resize-r', clip, scene, e);
            }}
          />
        )),
      )}
    </div>
  );
}

/**
 * Full pill card for a zoom clip. Shows the zoom factor and (compactly)
 * whether follow-cursor is on. Resize handles only appear while
 * hovering or when selected — keeps the lane visually calm when idle.
 */
function ZoomClipCard({
  clip,
  selected,
  leftPct,
  widthPct,
  onClick,
  onBodyMouseDown,
  onLeftMouseDown,
  onRightMouseDown,
}: {
  clip: ZoomClip;
  selected: boolean;
  leftPct: number;
  widthPct: number;
  onClick: (e: React.MouseEvent) => void;
  onBodyMouseDown: (e: React.MouseEvent) => void;
  onLeftMouseDown: (e: React.MouseEvent) => void;
  onRightMouseDown: (e: React.MouseEvent) => void;
}) {
  return (
    <div
      className={cn(
        'absolute top-1 bottom-1 rounded-md border flex items-center justify-center gap-1 text-xs font-medium group transition-colors',
        selected
          ? 'border-emerald-300 bg-emerald-500/40 text-emerald-50 shadow-[0_0_0_2px_rgba(16,185,129,0.4)]'
          : 'border-emerald-600/60 bg-emerald-600/25 text-emerald-50 hover:bg-emerald-500/35',
      )}
      style={{ left: `${leftPct}%`, width: `${widthPct}%`, cursor: 'grab' }}
      onMouseDown={onBodyMouseDown}
      onClick={onClick}
      title={`Zoom ${clip.zoom.toFixed(2)}×${clip.followCursor ? ' · follow cursor' : ''}`}
    >
      <ZoomIn className="size-3 shrink-0 opacity-80" />
      <span className="tabular-nums truncate">{clip.zoom.toFixed(clip.zoom % 1 === 0 ? 0 : 1)}×</span>

      {/* Left resize handle. Width is generous (6px) so it's easy to
          grab, visually only ~2px. */}
      <div
        className={cn(
          'absolute top-0 bottom-0 w-1.5 rounded-l-md transition-opacity',
          selected
            ? 'bg-emerald-200 opacity-100'
            : 'bg-emerald-200/70 opacity-0 group-hover:opacity-100',
        )}
        style={{ left: 0, cursor: 'ew-resize' }}
        onMouseDown={onLeftMouseDown}
        onClick={(e) => e.stopPropagation()}
      />
      <div
        className={cn(
          'absolute top-0 bottom-0 w-1.5 rounded-r-md transition-opacity',
          selected
            ? 'bg-emerald-200 opacity-100'
            : 'bg-emerald-200/70 opacity-0 group-hover:opacity-100',
        )}
        style={{ right: 0, cursor: 'ew-resize' }}
        onMouseDown={onRightMouseDown}
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}

/**
 * Trim lane. Mirrors ZoomLane but drops cut-range pills — plays skip
 * over them, exporter omits them from the output MP4. No followCursor
 * or zoom-level config to worry about, just start/end.
 */
function TrimLane({
  project,
  selectedTrimClipId,
  toPct,
  totalMs,
  onSelectTrimClip,
  onStartDrag,
  onAddTrimClip,
}: {
  project: EditorProject;
  selectedTrimClipId: string | null;
  toPct: (ms: number) => number;
  totalMs: number;
  onSelectTrimClip: (sceneId: string, clipId: string) => void;
  onStartDrag: (
    mode: 'move' | 'resize-l' | 'resize-r',
    clip: TrimClip,
    scene: Scene,
    e: React.MouseEvent,
  ) => void;
  onAddTrimClip: (sceneId: string, start: number, end: number) => void;
}) {
  const laneRef = useRef<HTMLDivElement>(null);
  const [hoverMs, setHoverMs] = useState<number | null>(null);

  const eventToMs = useCallback(
    (e: React.MouseEvent): number | null => {
      const el = laneRef.current;
      if (!el || totalMs <= 0) return null;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0) return null;
      const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
      return (x / rect.width) * totalMs;
    },
    [totalMs],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (e.target !== laneRef.current) {
        setHoverMs(null);
        return;
      }
      setHoverMs(eventToMs(e));
    },
    [eventToMs],
  );

  const handleMouseLeave = useCallback(() => setHoverMs(null), []);

  const handleLaneMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.target !== laneRef.current) return;
      const ms = eventToMs(e);
      if (ms == null) return;
      const scene = project.scenes.find((s) => ms >= s.start && ms < s.end);
      if (!scene) return;
      const half = DEFAULT_ADD_TRIM_DURATION_MS / 2;
      const start = Math.max(scene.start, ms - half);
      const end = Math.min(scene.end, start + DEFAULT_ADD_TRIM_DURATION_MS);
      onAddTrimClip(scene.id, start, end);
      e.preventDefault();
      e.stopPropagation();
    },
    [project.scenes, eventToMs, onAddTrimClip],
  );

  return (
    <div
      ref={laneRef}
      className="relative h-9 rounded-md bg-red-950/20 border border-border overflow-hidden cursor-copy"
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onMouseDown={handleLaneMouseDown}
      title="Click on empty space to mark a cut range"
    >
      {hoverMs != null && (
        <div
          className="absolute top-0 bottom-0 flex items-center pointer-events-none"
          style={{ left: `${toPct(hoverMs)}%` }}
        >
          <div className="w-px bg-red-400/60 h-full" />
          <div className="ml-0.5 flex items-center gap-1 px-1.5 py-0.5 rounded bg-red-600/90 text-white text-[10px]">
            <Plus className="size-3" />
            <span>Trim</span>
          </div>
        </div>
      )}

      {project.scenes.flatMap((scene) =>
        scene.trimClips.map((clip) => (
          <TrimClipCard
            key={clip.id}
            clip={clip}
            selected={clip.id === selectedTrimClipId}
            leftPct={toPct(clip.start)}
            widthPct={toPct(clip.end - clip.start)}
            onClick={(e) => {
              e.stopPropagation();
              onSelectTrimClip(scene.id, clip.id);
            }}
            onBodyMouseDown={(e) => {
              e.stopPropagation();
              onStartDrag('move', clip, scene, e);
            }}
            onLeftMouseDown={(e) => {
              e.stopPropagation();
              onStartDrag('resize-l', clip, scene, e);
            }}
            onRightMouseDown={(e) => {
              e.stopPropagation();
              onStartDrag('resize-r', clip, scene, e);
            }}
          />
        )),
      )}
    </div>
  );
}

function TrimClipCard({
  clip,
  selected,
  leftPct,
  widthPct,
  onClick,
  onBodyMouseDown,
  onLeftMouseDown,
  onRightMouseDown,
}: {
  clip: TrimClip;
  selected: boolean;
  leftPct: number;
  widthPct: number;
  onClick: (e: React.MouseEvent) => void;
  onBodyMouseDown: (e: React.MouseEvent) => void;
  onLeftMouseDown: (e: React.MouseEvent) => void;
  onRightMouseDown: (e: React.MouseEvent) => void;
}) {
  const durMs = clip.end - clip.start;
  return (
    <div
      className={cn(
        'absolute top-1 bottom-1 rounded-md border flex items-center justify-center gap-1 text-xs font-medium group transition-colors',
        selected
          ? 'border-red-300 bg-red-500/40 text-red-50 shadow-[0_0_0_2px_rgba(239,68,68,0.4)]'
          : 'border-red-600/60 bg-red-600/25 text-red-50 hover:bg-red-500/35',
      )}
      style={{
        left: `${leftPct}%`,
        width: `${widthPct}%`,
        cursor: 'grab',
        // Diagonal-stripe hatch so trim clips read as "cut" at a glance
        // even without reading the label.
        backgroundImage:
          'repeating-linear-gradient(45deg, transparent 0 6px, rgba(255,255,255,0.08) 6px 12px)',
      }}
      onMouseDown={onBodyMouseDown}
      onClick={onClick}
      title={`Cut ${fmt(durMs)}`}
    >
      <ScissorsSquare className="size-3 shrink-0 opacity-80" />
      <span className="tabular-nums truncate">{fmt(durMs)}</span>

      <div
        className={cn(
          'absolute top-0 bottom-0 w-1.5 rounded-l-md transition-opacity',
          selected
            ? 'bg-red-200 opacity-100'
            : 'bg-red-200/70 opacity-0 group-hover:opacity-100',
        )}
        style={{ left: 0, cursor: 'ew-resize' }}
        onMouseDown={onLeftMouseDown}
        onClick={(e) => e.stopPropagation()}
      />
      <div
        className={cn(
          'absolute top-0 bottom-0 w-1.5 rounded-r-md transition-opacity',
          selected
            ? 'bg-red-200 opacity-100'
            : 'bg-red-200/70 opacity-0 group-hover:opacity-100',
        )}
        style={{ right: 0, cursor: 'ew-resize' }}
        onMouseDown={onRightMouseDown}
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}

export function layoutLabel(layout: Scene['layout']) {
  switch (layout) {
    case 'screen-only':
      return 'Screen';
    case 'cam-only':
      return 'Camera';
    case 'split-horizontal':
      return 'Split';
    case 'screen-with-bubble':
      return 'Screen + bubble';
  }
}

/**
 * Pick a "nice" tick step so ~8–12 labels render at a given total
 * duration. Clamps to familiar increments so the labels fall on round
 * seconds/minutes rather than awkward half-beats.
 */
function pickTickStep(totalMs: number): number {
  if (totalMs <= 0) return 0;
  const candidates = [
    1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000,
  ];
  // Aim for ~10 ticks.
  const target = totalMs / 10;
  return candidates.find((c) => c >= target) ?? candidates[candidates.length - 1];
}

function fmt(ms: number) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(m)}:${pad(s % 60)}.${pad(Math.floor((ms % 1000) / 10))}`;
}

// Shorter variant used on ruler ticks — no sub-second digits, no
// padding on the minute.
function fmtShort(ms: number) {
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m === 0) return `0:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
