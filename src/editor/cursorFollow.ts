import type { CursorTrack } from '@/platform';
import type { SourceTransform, ZoomClip } from './types';

/**
 * Cursor-follow math. Given a cursor position in source coordinates and
 * the current fit/zoom, compute the `offsetX`/`offsetY` that centers the
 * zoomed view on the cursor, clamped to the source's pannable range.
 *
 * Kept separate from the compositor so the preview and (eventually) the
 * ffmpeg exporter can share it.
 */

/**
 * Binary-search the cursor track for the sample at time `ms` (ms from
 * recording start) and return a linearly interpolated {x, y} in cursor-
 * track coordinates (same as the recording's display DIP).
 */
export function cursorAt(track: CursorTrack, ms: number): { x: number; y: number } | null {
  const s = track.samples;
  if (s.length === 0) return null;
  if (ms <= s[0].t) return { x: s[0].x, y: s[0].y };
  if (ms >= s[s.length - 1].t) return { x: s[s.length - 1].x, y: s[s.length - 1].y };
  // Binary search for the last sample with t <= ms.
  let lo = 0;
  let hi = s.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (s[mid].t <= ms) lo = mid;
    else hi = mid - 1;
  }
  const a = s[lo];
  const b = s[Math.min(lo + 1, s.length - 1)];
  if (b.t === a.t) return { x: a.x, y: a.y };
  const f = (ms - a.t) / (b.t - a.t);
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}

/**
 * Compute the offset that would center the zoomed view on `cursor`.
 *
 * Reverses the compositor's transform math:
 *   scaledSrcTopLeft_x = (targetW - scaledSrcW)/2 + offsetX * targetW
 *   cursorOnCanvas_x = scaledSrcTopLeft_x + cursor.x * scale
 * Setting cursorOnCanvas to target center gives:
 *   offsetX = (scale * (srcW/2 - cursor.x)) / targetW
 */
export function followOffset(
  cursor: { x: number; y: number },
  source: { width: number; height: number },
  target: { width: number; height: number },
  transform: SourceTransform,
): { offsetX: number; offsetY: number } {
  if (source.width === 0 || source.height === 0) {
    return { offsetX: 0, offsetY: 0 };
  }
  const fitScale =
    transform.fit === 'cover'
      ? Math.max(target.width / source.width, target.height / source.height)
      : Math.min(target.width / source.width, target.height / source.height);
  const scale = fitScale * transform.zoom;
  const scaledW = source.width * scale;
  const scaledH = source.height * scale;

  const desiredX = (scale * (source.width / 2 - cursor.x)) / target.width;
  const desiredY = (scale * (source.height / 2 - cursor.y)) / target.height;

  // Clamp so the viewport stays inside the source — no bouncing off into
  // black bars when the cursor approaches an edge.
  const maxX = Math.max(0, (scaledW - target.width) / (2 * target.width));
  const maxY = Math.max(0, (scaledH - target.height) / (2 * target.height));
  return {
    offsetX: Math.max(-maxX, Math.min(maxX, desiredX)),
    offsetY: Math.max(-maxY, Math.min(maxY, desiredY)),
  };
}

/**
 * Exponential smoothing — nudges `prev` toward `target` by a fixed
 * fraction. Call per frame.
 */
export function smoothOffset(
  prev: { x: number; y: number },
  target: { offsetX: number; offsetY: number },
  alpha = 0.15,
): { x: number; y: number } {
  return {
    x: prev.x + alpha * (target.offsetX - prev.x),
    y: prev.y + alpha * (target.offsetY - prev.y),
  };
}

/**
 * Find the zoom clip covering project-time `ms`, or null. Clips are
 * expected to be non-overlapping (enforced by the Inspector/timeline
 * UI); a simple linear scan wins vs. a sort tree when the list is tiny
 * (typically 0..10 clips per scene).
 */
export function activeZoomClip(
  clips: ZoomClip[],
  ms: number,
): ZoomClip | null {
  for (const c of clips) {
    if (ms >= c.start && ms < c.end) return c;
  }
  return null;
}

/**
 * Project a cursor position (in source pixels) to canvas pixels, using
 * the same math the compositor uses to place the scaled source. Returns
 * null if the cursor would fall outside the target rect after placement
 * — no point drawing an overlay the user can't see.
 */
export function cursorCanvasPos(
  cursor: { x: number; y: number },
  source: { width: number; height: number },
  target: { x: number; y: number; width: number; height: number },
  transform: SourceTransform,
): { x: number; y: number } | null {
  if (source.width === 0 || source.height === 0) return null;
  const fitScale =
    transform.fit === 'cover'
      ? Math.max(target.width / source.width, target.height / source.height)
      : Math.min(target.width / source.width, target.height / source.height);
  const scale = fitScale * transform.zoom;
  const cx =
    target.x +
    target.width / 2 +
    transform.offsetX * target.width +
    (cursor.x - source.width / 2) * scale;
  const cy =
    target.y +
    target.height / 2 +
    transform.offsetY * target.height +
    (cursor.y - source.height / 2) * scale;
  if (
    cx < target.x ||
    cx > target.x + target.width ||
    cy < target.y ||
    cy > target.y + target.height
  ) {
    return null;
  }
  return { x: cx, y: cy };
}

/**
 * Draw a stylised pointer at (x, y). Shape matches the macOS system
 * arrow (tip at the given coordinate, tilted left). Filled white with a
 * dark outline so it stays legible over any background. Sizing is a
 * fraction of the canvas min dimension so it reads similarly in
 * portrait/landscape/square.
 */
export function drawCursorOverlay(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  canvasMinDim: number,
): void {
  // Target height ≈ 6% of the canvas min dim — big enough to read on a
  // 1080-tall portrait export without dominating the frame.
  const targetPx = Math.max(24, canvasMinDim * 0.06);
  // The path below is authored in a 24-unit-tall coordinate space with
  // the tip at (0, 0). Scale so path-height maps to targetPx.
  const s = targetPx / 24;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, 20);
  ctx.lineTo(5.5, 15);
  ctx.lineTo(9.5, 23);
  ctx.lineTo(12.5, 21.5);
  ctx.lineTo(8.5, 13.5);
  ctx.lineTo(15, 13.5);
  ctx.closePath();
  ctx.lineJoin = 'round';
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.95)';
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.restore();
}
