import { useCallback, useEffect, useRef } from 'react';
import type { Scene, TrimClip, ZoomClip } from './types';

/**
 * Generic drag / resize hook for clips living on a scene lane.
 *
 * Works for both zoom and trim clips — the only per-kind difference is
 * which array on the scene holds siblings (for overlap clamping). The
 * caller supplies `kind` on startDrag and the hook pulls the right
 * sibling list.
 *
 * Two gesture modes:
 *   - 'move'     : drag the body — both `start` and `end` translate.
 *   - 'resize-l' : drag the left edge — `start` only.
 *   - 'resize-r' : drag the right edge — `end` only.
 *
 * Ranges clamp to the parent scene's bounds plus the nearest sibling
 * clip edges. MIN_CLIP_DURATION_MS prevents collapsing a clip to zero.
 *
 * Click-vs-drag is differentiated by a 3px threshold so users can click
 * to select without nudging by 0.5ms.
 */

export type ClipDragMode = 'move' | 'resize-l' | 'resize-r';
export type ClipKind = 'zoom' | 'trim';

type AnyClip = Pick<ZoomClip, 'id' | 'start' | 'end'> | TrimClip;

const DRAG_THRESHOLD_PX = 3;
const MIN_CLIP_DURATION_MS = 100;

interface DragState {
  mode: ClipDragMode;
  kind: ClipKind;
  clipId: string;
  sceneId: string;
  startClientX: number;
  baseStart: number;
  baseEnd: number;
  pxPerMs: number;
  /** Minimum allowed `start` for the active edge (move = clip start). */
  minStart: number;
  /** Maximum allowed `end` for the active edge (move = clip end). */
  maxEnd: number;
  moved: boolean;
}

interface Options {
  rulerRef: React.RefObject<HTMLDivElement>;
  totalMs: number;
  onUpdateZoom: (sceneId: string, clipId: string, patch: Partial<ZoomClip>) => void;
  onUpdateTrim: (sceneId: string, clipId: string, patch: Partial<TrimClip>) => void;
}

export function useClipDrag({
  rulerRef,
  totalMs,
  onUpdateZoom,
  onUpdateTrim,
}: Options) {
  const stateRef = useRef<DragState | null>(null);
  // Live refs so listeners installed on mount don't close over stale callbacks.
  const zoomRef = useRef(onUpdateZoom);
  zoomRef.current = onUpdateZoom;
  const trimRef = useRef(onUpdateTrim);
  trimRef.current = onUpdateTrim;

  const startDrag = useCallback(
    (
      kind: ClipKind,
      mode: ClipDragMode,
      clip: AnyClip,
      scene: Scene,
      event: React.MouseEvent,
    ) => {
      const ruler = rulerRef.current;
      if (!ruler || totalMs <= 0) return;
      const rect = ruler.getBoundingClientRect();
      if (rect.width === 0) return;

      // Siblings of the same kind constrain the active edge. Cross-kind
      // overlap is allowed (a zoom and a trim at the same time is a
      // valid — if weird — configuration; the trim just wins at render).
      const siblingList: AnyClip[] =
        kind === 'zoom' ? scene.zoomClips : scene.trimClips;
      const siblings = siblingList.filter((c) => c.id !== clip.id);
      const leftNeighborEnd = siblings
        .filter((c) => c.end <= clip.start)
        .reduce((acc, c) => Math.max(acc, c.end), scene.start);
      const rightNeighborStart = siblings
        .filter((c) => c.start >= clip.end)
        .reduce((acc, c) => Math.min(acc, c.start), scene.end);

      stateRef.current = {
        mode,
        kind,
        clipId: clip.id,
        sceneId: scene.id,
        startClientX: event.clientX,
        baseStart: clip.start,
        baseEnd: clip.end,
        pxPerMs: rect.width / totalMs,
        minStart: leftNeighborEnd,
        maxEnd: rightNeighborStart,
        moved: false,
      };
      event.preventDefault();
      event.stopPropagation();
    },
    [rulerRef, totalMs],
  );

  useEffect(() => {
    const emit = (s: DragState, patch: { start?: number; end?: number }) => {
      if (s.kind === 'zoom') zoomRef.current(s.sceneId, s.clipId, patch);
      else trimRef.current(s.sceneId, s.clipId, patch);
    };

    const handleMove = (e: MouseEvent) => {
      const s = stateRef.current;
      if (!s) return;
      const dxPx = e.clientX - s.startClientX;
      if (!s.moved && Math.abs(dxPx) < DRAG_THRESHOLD_PX) return;
      s.moved = true;
      const dMs = dxPx / s.pxPerMs;

      if (s.mode === 'move') {
        const dur = s.baseEnd - s.baseStart;
        const minStart = s.minStart;
        const maxStart = s.maxEnd - dur;
        const newStart = Math.max(minStart, Math.min(maxStart, s.baseStart + dMs));
        emit(s, { start: newStart, end: newStart + dur });
      } else if (s.mode === 'resize-l') {
        const minStart = s.minStart;
        const maxStart = s.baseEnd - MIN_CLIP_DURATION_MS;
        const newStart = Math.max(minStart, Math.min(maxStart, s.baseStart + dMs));
        emit(s, { start: newStart });
      } else if (s.mode === 'resize-r') {
        const minEnd = s.baseStart + MIN_CLIP_DURATION_MS;
        const maxEnd = s.maxEnd;
        const newEnd = Math.max(minEnd, Math.min(maxEnd, s.baseEnd + dMs));
        emit(s, { end: newEnd });
      }
    };
    const handleUp = () => {
      stateRef.current = null;
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, []);

  return { startDrag };
}
