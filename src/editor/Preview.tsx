import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import type { MediaMap } from './usePlayback';
import { composite, primaryRole, roleTargetRect } from './compositor';
import {
  activeZoomClip,
  cursorAt,
  cursorCanvasPos,
  drawCursorOverlay,
  followOffset,
  smoothOffset,
} from './cursorFollow';
import type { EditorProject, Scene, SourceRole, SourceTransform } from './types';

interface Props {
  project: EditorProject;
  scene: Scene | null;
  mediaRef: React.MutableRefObject<MediaMap>;
  playing: boolean;
  /** Current output-time ms. Needed for cursor-follow lookup. */
  playheadMs: number;
  onPan?: (role: SourceRole, patch: Partial<SourceTransform>) => void;
}

export interface PreviewHandle {
  canvas: HTMLCanvasElement | null;
}

/**
 * Canvas preview. Composites all sources every rAF. Drag on the preview
 * pans the layout's primary source (screen in screen-only / with-bubble /
 * split, cam in cam-only) — same gesture as OpenScreen.
 */
export const Preview = forwardRef<PreviewHandle, Props>(function Preview(
  { project, scene, mediaRef, playing, playheadMs, onPan },
  outerRef,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef(playheadMs);
  playheadRef.current = playheadMs;
  // Smoothed cursor-follow offset carried across frames. The `key`
  // identifies what's currently driving the follow — a zoom clip
  // (`clip:<id>`), the scene baseline (`scene:<id>`), or nothing (null).
  // When the key flips between sources we snap to the fresh target rather
  // than tweening — prevents a visible jump/drift at the transition.
  const followRef = useRef<{ x: number; y: number; key: string | null }>({
    x: 0,
    y: 0,
    key: null,
  });

  useImperativeHandle(outerRef, () => ({
    get canvas() {
      return canvasRef.current;
    },
  }));

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    c.width = project.canvas.width;
    c.height = project.canvas.height;
  }, [project.canvas.width, project.canvas.height]);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    // Always composite at the rAF cadence. We tried gating this on
    // "playhead changed since last draw" to save CPU while paused, but
    // setting `video.currentTime` is asynchronous — the new frame isn't
    // decoded yet on the rAF tick the seek happens. Skipping subsequent
    // ticks meant the canvas was stuck on whatever frame happened to be
    // decoded last (usually frame 0). Drawing every tick is the only
    // race-free way to catch the new frame whenever it lands. The
    // downstream cost is bounded — most seeks complete in <50ms once the
    // WebM is remuxed at finalize time.
    const draw = () => {
      const s = scene;
      if (s) {
        const screen = mediaRef.current['screen'];
        const cam = mediaRef.current['laptop-cam'];
        const mobile = mediaRef.current['mobile-cam'];
        const scrEl = screen as HTMLVideoElement | undefined;

        // Resolve the active zoom clip for the screen, if any. When a
        // clip covers the current playhead, it replaces the screen's
        // zoom / offsets for this frame — and, if the clip asks for
        // cursor-follow, the offsets are overridden per-frame to track
        // the recorded cursor with temporal smoothing.
        let screenTransform = s.screenTransform;
        const clip = activeZoomClip(s.zoomClips, playheadRef.current);

        // Compute cursor-in-source once if any consumer (zoom clip follow
        // OR scene-level follow OR project-level big cursor overlay) will
        // need it.
        let cursorInSrc: { x: number; y: number } | null = null;
        const wantsCursor =
          (project.showCursorOverlay ||
            (clip && clip.followCursor) ||
            (!clip && s.followCursor)) &&
          project.cursorTrack &&
          scrEl &&
          scrEl.videoWidth > 0;
        if (wantsCursor) {
          // Cursor samples are keyed on screen-track local time, not output time.
          const screenTrack = project.tracks.find((t) => t.kind === 'screen');
          const screenOffsetMs = screenTrack
            ? screenTrack.startedAtMs - project.sessionStartMs
            : 0;
          const trackMs = playheadRef.current - screenOffsetMs;
          const raw = cursorAt(project.cursorTrack!, trackMs);
          if (raw) {
            const track = project.cursorTrack!;
            const srcW = scrEl!.videoWidth;
            const srcH = scrEl!.videoHeight;
            cursorInSrc = {
              x: raw.x * (srcW / track.display.width),
              y: raw.y * (srcH / track.display.height),
            };
          }
        }

        // Decide the "base" transform and whether to run cursor-follow.
        // Three cases:
        //   1) Active zoom clip — clip zoom/offset, clip.followCursor flag.
        //   2) No clip, scene.followCursor on — scene screenTransform, follow.
        //   3) No clip, no scene follow — scene screenTransform, no follow.
        if (scrEl && scrEl.videoWidth > 0) {
          const base: typeof s.screenTransform = clip
            ? {
                ...s.screenTransform,
                zoom: clip.zoom,
                offsetX: clip.offsetX,
                offsetY: clip.offsetY,
              }
            : s.screenTransform;
          const wantsFollow =
            cursorInSrc !== null &&
            (clip ? clip.followCursor : s.followCursor);
          const followKey = clip ? `clip:${clip.id}` : `scene:${s.id}`;

          if (wantsFollow && cursorInSrc) {
            const target = followOffset(
              cursorInSrc,
              { width: scrEl.videoWidth, height: scrEl.videoHeight },
              { width: project.canvas.width, height: project.canvas.height },
              base,
            );
            // At a follow transition (scene → clip, clip → scene, new
            // clip) snap instead of tweening from wherever we left off.
            // Otherwise the first ~250ms shows the old offset drifting
            // into the new pose, which reads as "stuck at the top of the
            // screen for a moment." Snap first, smooth after.
            if (followRef.current.key !== followKey) {
              followRef.current = {
                x: target.offsetX,
                y: target.offsetY,
                key: followKey,
              };
            }
            const smoothed = smoothOffset(
              { x: followRef.current.x, y: followRef.current.y },
              target,
              0.25, // snappier than the old 0.15 — less visible lag.
            );
            followRef.current.x = smoothed.x;
            followRef.current.y = smoothed.y;
            screenTransform = {
              ...base,
              offsetX: smoothed.x,
              offsetY: smoothed.y,
            };
          } else {
            // Not following — use the base as-is. Seed the smoothing
            // buffer with the current offset so the next follow
            // transition has a sensible starting point (even though
            // we'll snap on the first follow frame regardless).
            followRef.current = {
              x: base.offsetX,
              y: base.offsetY,
              key: clip ? `clip:${clip.id}:still` : `scene:${s.id}:still`,
            };
            screenTransform = base;
          }
        }

        composite(
          ctx,
          project.canvas,
          s.layout,
          s.bubbleCorner,
          s.secondarySource,
          {
            screen: scrEl ?? null,
            cam: (cam as HTMLVideoElement | undefined) ?? null,
            mobile: (mobile as HTMLVideoElement | undefined) ?? null,
          },
          screenTransform,
          s.camTransform,
        );

        // Big cursor overlay — drawn after compositing so it sits on
        // top of both the screen and the bubble. Only meaningful on
        // layouts that actually show the screen (the cursor's source).
        if (
          project.showCursorOverlay &&
          cursorInSrc &&
          scrEl &&
          (s.layout === 'screen-only' ||
            s.layout === 'screen-with-bubble' ||
            s.layout === 'split-horizontal')
        ) {
          const rect = roleTargetRect('screen', s.layout, project.canvas);
          const pos = cursorCanvasPos(
            cursorInSrc,
            { width: scrEl.videoWidth, height: scrEl.videoHeight },
            { x: rect.x, y: rect.y, width: rect.w, height: rect.h },
            screenTransform,
          );
          if (pos) {
            const minDim = Math.min(project.canvas.width, project.canvas.height);
            drawCursorOverlay(ctx, pos.x, pos.y, minDim);
          }
        }
      } else {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, c.width, c.height);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [
    project.canvas,
    project.cursorTrack,
    project.tracks,
    project.sessionStartMs,
    project.showCursorOverlay,
    scene,
    mediaRef,
    playing,
  ]);

  // Drag-to-pan on the canvas.
  const dragStateRef = useRef<{
    startX: number;
    startY: number;
    baseX: number;
    baseY: number;
    role: SourceRole;
    targetW: number;
    targetH: number;
    canvasPxPerUnit: number;
  } | null>(null);

  const onCanvasMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!scene || !onPan) return;
      const role = primaryRole(scene.layout);
      if (!role) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      // Each CSS pixel corresponds to this many canvas units.
      const canvasPxPerUnit = rect.width / project.canvas.width;
      const target = roleTargetRect(role, scene.layout, project.canvas);
      const transform = role === 'screen' ? scene.screenTransform : scene.camTransform;
      dragStateRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        baseX: transform.offsetX,
        baseY: transform.offsetY,
        role,
        targetW: target.w,
        targetH: target.h,
        canvasPxPerUnit,
      };
      (e.target as HTMLElement).style.cursor = 'grabbing';
      e.preventDefault();
    },
    [scene, onPan, project.canvas],
  );

  useEffect(() => {
    const handleMove = (e: MouseEvent) => {
      const d = dragStateRef.current;
      if (!d || !onPan) return;
      // Pixel delta in CSS → canvas units → fraction of target rect.
      const dxCanvas = (e.clientX - d.startX) / d.canvasPxPerUnit;
      const dyCanvas = (e.clientY - d.startY) / d.canvasPxPerUnit;
      const offsetX = d.baseX + dxCanvas / d.targetW;
      const offsetY = d.baseY + dyCanvas / d.targetH;
      onPan(d.role, { offsetX, offsetY });
    };
    const handleUp = () => {
      if (dragStateRef.current) {
        dragStateRef.current = null;
        if (canvasRef.current) canvasRef.current.style.cursor = 'grab';
      }
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [onPan]);

  return (
    <div
      ref={wrapRef}
      className="flex-1 min-h-0 min-w-0 flex items-center justify-center bg-black/40 rounded-xl overflow-hidden"
    >
      <canvas
        ref={canvasRef}
        onMouseDown={onCanvasMouseDown}
        className="block"
        style={{
          aspectRatio: `${project.canvas.width} / ${project.canvas.height}`,
          maxWidth: '100%',
          maxHeight: '100%',
          width: 'auto',
          height: 'auto',
          objectFit: 'contain',
          cursor: onPan && scene ? 'grab' : 'default',
        }}
      />
    </div>
  );
});
