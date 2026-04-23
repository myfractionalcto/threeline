import { useCallback, useEffect, useRef } from 'react';
import { Pause, Play, Scissors, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { EditorProject, Scene } from './types';

// Modifier glyph for keyboard-shortcut pills. Mac uses ⌘; everywhere else
// we show "Ctrl+" so the hint matches what the user actually has to press.
// The keybinding handler accepts either metaKey or ctrlKey regardless.
const IS_MAC =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD_KEY = IS_MAC ? '⌘' : 'Ctrl+';

interface Props {
  project: EditorProject;
  playheadMs: number;
  playing: boolean;
  selectedSceneId: string | null;
  onSeek: (ms: number) => void;
  onTogglePlay: () => void;
  onSelectScene: (id: string) => void;
  onSplitAtPlayhead: () => void;
  onDeleteScene: (id: string) => void;
}

export function Timeline({
  project,
  playheadMs,
  playing,
  selectedSceneId,
  onSeek,
  onTogglePlay,
  onSelectScene,
  onSplitAtPlayhead,
  onDeleteScene,
}: Props) {
  const rulerRef = useRef<HTMLDivElement>(null);

  const totalMs = project.totalDurationMs;

  const toPct = useCallback(
    (ms: number) => (totalMs > 0 ? (ms / totalMs) * 100 : 0),
    [totalMs],
  );

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

  // Drag-to-scrub on the ruler.
  useEffect(() => {
    const el = rulerRef.current;
    if (!el) return;
    let down = false;
    const handleDown = (e: MouseEvent) => {
      down = true;
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
  }, [handleSeekFromEvent]);

  return (
    <div className="border-t border-border/60 bg-card/40 p-4 space-y-3 shrink-0">
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
            Delete scene
          </button>
        </div>
      </div>

      <div
        ref={rulerRef}
        className="relative h-14 rounded-md bg-secondary/40 border border-border cursor-pointer select-none"
      >
        {/* Scene blocks */}
        {project.scenes.map((scene, i) => (
          <SceneBlock
            key={scene.id}
            scene={scene}
            index={i}
            selected={scene.id === selectedSceneId}
            leftPct={toPct(scene.start)}
            widthPct={toPct(scene.end - scene.start)}
            onClick={(e) => {
              e.stopPropagation();
              onSelectScene(scene.id);
            }}
          />
        ))}
        {/* Playhead */}
        <div
          className="absolute top-0 bottom-0 w-px bg-red-500 pointer-events-none"
          style={{ left: `${toPct(playheadMs)}%` }}
        >
          <div className="absolute -top-1 -translate-x-1/2 w-3 h-3 rounded-full bg-red-500" />
        </div>
      </div>

      {/* Track legend */}
      <div className="flex gap-4 text-xs text-muted-foreground">
        {project.tracks.map((t) => (
          <span key={t.id} className="inline-flex items-center gap-1.5">
            <span
              className={cn(
                'size-2 rounded-full',
                t.kind === 'screen' && 'bg-blue-400',
                t.kind === 'laptop-cam' && 'bg-pink-400',
                t.kind === 'laptop-mic' && 'bg-green-400',
              )}
            />
            {t.kind}
          </span>
        ))}
      </div>
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
  // Local helper: map clip time (absolute project ms) to a percentage
  // inside the scene block's own width, so the zoom-clip markers nest
  // correctly no matter how the scene is placed on the timeline.
  const sceneDur = Math.max(1, scene.end - scene.start);
  const clipStyle = (startMs: number, endMs: number) => ({
    left: `${((startMs - scene.start) / sceneDur) * 100}%`,
    width: `${((endMs - startMs) / sceneDur) * 100}%`,
  });
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
      {/* Zoom-clip markers — a small green strip inside the scene. Full
          drag/resize UX lands in Phase 2 of the timeline redesign. */}
      {scene.zoomClips.map((c) => (
        <div
          key={c.id}
          className="absolute top-0 h-1.5 rounded-b-sm bg-emerald-500/80"
          style={clipStyle(c.start, c.end)}
          title={`Zoom ${c.zoom.toFixed(2)}×${c.followCursor ? ' · follow' : ''}`}
        />
      ))}
    </button>
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

function fmt(ms: number) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(m)}:${pad(s % 60)}.${pad(Math.floor((ms % 1000) / 10))}`;
}
