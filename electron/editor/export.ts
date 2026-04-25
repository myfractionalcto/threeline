import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import ffmpegPath from 'ffmpeg-static';

/**
 * Scene-by-scene MP4 export.
 *
 * Strategy: render each scene to its own temp MP4 via a single ffmpeg
 * invocation (one complex filter graph), then concat all the scene MP4s
 * with the concat demuxer. This keeps each filter graph small and avoids
 * one-giant-graph debugging hell.
 *
 * Tradeoff: we transcode twice for long projects (once per scene, once for
 * concat). For v1 correctness > speed. We can switch to a single pass
 * later if exports feel slow.
 */

export interface ExportSourceTransform {
  fit: 'contain' | 'cover';
  zoom: number;
  offsetX: number;
  offsetY: number;
}

export interface ExportZoomClip {
  start: number;
  end: number;
  zoom: number;
  offsetX: number;
  offsetY: number;
  followCursor: boolean;
}

export interface ExportTrimClip {
  start: number;
  end: number;
}

export interface ExportRequest {
  projectId: string;
  projectName?: string;
  /** Absolute path chosen by the user via a save dialog. The IPC layer
   *  resolves this before calling exportProject — export never prompts. */
  outputPath: string;
  canvas: { width: number; height: number };
  scenes: {
    id: string;
    start: number;
    end: number;
    layout:
      | 'screen-only'
      | 'cam-only'
      | 'mobile-only'
      | 'split-horizontal'
      | 'screen-with-bubble';
    bubbleCorner: 'tl' | 'tr' | 'bl' | 'br';
    /** Which track fills the cam slot in split/bubble layouts. */
    secondarySource: 'cam' | 'mobile';
    audioSource: string | null;
    screenTransform: ExportSourceTransform;
    camTransform: ExportSourceTransform;
    /** Baseline cursor-follow for the scene (applied outside zoom clips). */
    followCursor: boolean;
    /** Ordered non-overlapping zoom effect clips. Non-intersecting gaps
     *  fall back to the scene baseline. */
    zoomClips: ExportZoomClip[];
    /** Cut ranges the exporter must omit from the output. Applied by
     *  splitting the scene into surviving sub-scenes before rendering —
     *  see `splitSceneByTrims`. */
    trimClips: ExportTrimClip[];
  }[];
  tracks: {
    id: string;
    offsetMs: number;
    durationMs: number;
    filePath?: string;
  }[];
  orientation: 'portrait' | 'landscape' | 'square';
  /** Recorded cursor samples (ms are screen-track local, not output). The
   *  exporter uses these for follow-cursor segmentation. Absent → follow
   *  falls back to the static offset on the clip/scene. */
  cursorTrack?: {
    samples: { t: number; x: number; y: number }[];
    display: { width: number; height: number };
  };
}

/**
 * Filter sub-graph that frames a single source at target W×H, applying the
 * (fit, zoom, offsetX, offsetY) transform — equivalent to the canvas
 * compositor's `drawWithTransform` logic.
 *
 * 1. Build a black W×H background of the scene's duration.
 * 2. Scale source with fit flag at (W*zoom, H*zoom) — produces an image
 *    at least/at most covering the zoomed target.
 * 3. Overlay the scaled source on the background, centering it and
 *    shifting by offset * target dimensions.
 *
 * The overlay filter clips automatically to the background, so we don't
 * need an explicit crop step.
 */
function transformedSource(
  inputLabel: string,
  targetW: number,
  targetH: number,
  t: ExportSourceTransform,
  durationSec: number,
  suffix: string,
): { chain: string; outLabel: string } {
  const fitFlag =
    t.fit === 'cover'
      ? 'force_original_aspect_ratio=increase'
      : 'force_original_aspect_ratio=decrease';
  const zoom = Math.max(0.1, t.zoom);
  const zW = Math.max(1, Math.round(targetW * zoom));
  const zH = Math.max(1, Math.round(targetH * zoom));
  const offX = t.offsetX.toFixed(4);
  const offY = t.offsetY.toFixed(4);
  const bg = `bg_${suffix}`;
  const sc = `sc_${suffix}`;
  const fr = `fr_${suffix}`;
  // Overlay clips to the background bounds so anything panned off-frame
  // just disappears — same visual as the canvas compositor's target-rect
  // clipping.
  const chain =
    `color=c=black:s=${targetW}x${targetH}:d=${durationSec.toFixed(3)}[${bg}];` +
    `[${inputLabel}]scale=${zW}:${zH}:${fitFlag}[${sc}];` +
    `[${bg}][${sc}]overlay=` +
    `x=(${targetW}-w)/2+(${offX})*${targetW}:` +
    `y=(${targetH}-h)/2+(${offY})*${targetH}` +
    `[${fr}]`;
  return { chain, outLabel: `[${fr}]` };
}

/**
 * Cursor-follow math ported from `src/editor/cursorFollow.ts` — kept in
 * sync manually so the exporter doesn't have to import renderer code.
 * Computes the `offsetX`/`offsetY` that centers the zoomed view on the
 * cursor, clamped so the viewport stays inside the source.
 */
function followOffset(
  cursor: { x: number; y: number },
  source: { width: number; height: number },
  target: { width: number; height: number },
  transform: ExportSourceTransform,
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
  const maxX = Math.max(0, (scaledW - target.width) / (2 * target.width));
  const maxY = Math.max(0, (scaledH - target.height) / (2 * target.height));
  return {
    offsetX: Math.max(-maxX, Math.min(maxX, desiredX)),
    offsetY: Math.max(-maxY, Math.min(maxY, desiredY)),
  };
}

/**
 * Binary-search a cursor sample list for time `ms` and linearly interpolate.
 * Mirrors `cursorAt` in the renderer.
 */
function cursorAtMs(
  samples: { t: number; x: number; y: number }[],
  ms: number,
): { x: number; y: number } | null {
  if (samples.length === 0) return null;
  if (ms <= samples[0].t) return { x: samples[0].x, y: samples[0].y };
  const last = samples[samples.length - 1];
  if (ms >= last.t) return { x: last.x, y: last.y };
  let lo = 0;
  let hi = samples.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (samples[mid].t <= ms) lo = mid;
    else hi = mid - 1;
  }
  const a = samples[lo];
  const b = samples[Math.min(lo + 1, samples.length - 1)];
  if (b.t === a.t) return { x: a.x, y: a.y };
  const f = (ms - a.t) / (b.t - a.t);
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}

/**
 * Cursor sampling interval for follow-cursor, in ms. Each tick emits
 * one (offsetX, offsetY) waypoint that drives the block's overlay
 * position via `sendcmd` at export time.
 *
 * Must match the output frame interval (1000/fps) or finer. `sendcmd`
 * applies each command instantly and holds the new x/y until the next
 * command fires — so at a sampling interval of 200 ms and an output
 * rate of 30 fps, 6 consecutive frames render at the same overlay
 * position before snapping to the next sample. In zoom-clip regions
 * the zoom factor amplifies the visible step, making the panning look
 * chunky. Sampling once per output frame (≈33 ms at 30 fps) gives
 * every frame its own position and the motion reads as continuous.
 *
 * Prior to v0.2.1 each sample became its own split+trim+scale+overlay
 * sub-chain, so a 230 s follow scene built 1149 segments × 5 filters
 * plus a 1149-way split; ffmpeg's filter allocator died mid-graph with
 * "Failed to configure output pad on Parsed_scale_N / Error
 * reinitializing filters". The current block-level graph keeps filter
 * count linear in the number of zoom clips (typically ≤10), not in
 * sample count — sample count only grows the `sendcmd` command
 * string, which scales cheaply: a 230 s scene at 33 ms produces ~7k
 * commands totalling ~500 KB of argv, well under the 1 MB macOS
 * ARG_MAX limit.
 */
const FOLLOW_SAMPLE_MS = 33;

/** Temporal smoothing factor — matches the preview's 0.25 exponential
 *  smoothing so previewed and exported follow paths look the same. */
const FOLLOW_SMOOTH_ALPHA = 0.25;

/**
 * One contiguous run of the scene's screen stream with a constant
 * (zoom, fit, base) transform. If `followSamples` is populated, the
 * overlay position pans between those waypoints during the block; if
 * null, the block uses `base.offsetX`/`base.offsetY` statically.
 *
 * Times are scene-relative (ms from scene.start). Sample `tMs` values
 * inside `followSamples` are also scene-relative and always fall within
 * [startMs, endMs).
 */
interface ScreenBlock {
  startMs: number;
  endMs: number;
  base: ExportSourceTransform;
  followSamples: { tMs: number; offsetX: number; offsetY: number }[] | null;
}

/**
 * Break a scene up into screen-transform blocks honoring zoom clips and
 * cursor-follow. Algorithm:
 *
 *   1. Walk the scene's timeline inserting zoom-clip boundaries as cuts
 *      (everything outside clips uses scene.screenTransform). Each
 *      resulting block carries a single (zoom, fit, base-offset) — only
 *      offsetX/offsetY can vary within the block, via follow-cursor.
 *   2. For follow blocks with cursor data, attach a `followSamples`
 *      array sampled at FOLLOW_SAMPLE_MS with the same exponential
 *      smoothing the preview uses (α = FOLLOW_SMOOTH_ALPHA).
 *
 * The preview reads the video element's natural size for source dims;
 * we don't have that at export time without an ffprobe pass. Assume the
 * cursor track's display.width/height are a good proxy — screens
 * recorded via desktopCapturer match the display's backing resolution
 * up to rounding.
 */
function planScreenBlocks(
  scene: ExportRequest['scenes'][number],
  canvas: { width: number; height: number },
  cursorTrack: ExportRequest['cursorTrack'] | undefined,
  screenOffsetMs: number,
  /** W/H of the screen-transform's target rect — canvas-sized in
   *  screen-only layouts, half-canvas in split, etc. Clamp math differs
   *  per layout, so the caller supplies it. */
  targetW: number,
  targetH: number,
): ScreenBlock[] {
  const durMs = scene.end - scene.start;
  const clipsSorted = [...scene.zoomClips].sort((a, b) => a.start - b.start);

  // Build a "blocks" list — contiguous runs with a single base transform
  // plus a flag for whether cursor-follow is on.
  interface Block {
    startMs: number; // scene-relative
    endMs: number;
    base: ExportSourceTransform;
    follow: boolean;
  }
  const blocks: Block[] = [];
  let cursor = 0;
  for (const clip of clipsSorted) {
    const clipStart = Math.max(0, clip.start - scene.start);
    const clipEnd = Math.min(durMs, clip.end - scene.start);
    if (clipEnd <= cursor) continue;
    if (clipStart > cursor) {
      // Scene baseline block before this clip.
      blocks.push({
        startMs: cursor,
        endMs: clipStart,
        base: scene.screenTransform,
        follow: scene.followCursor,
      });
    }
    blocks.push({
      startMs: Math.max(cursor, clipStart),
      endMs: clipEnd,
      base: {
        ...scene.screenTransform,
        zoom: clip.zoom,
        offsetX: clip.offsetX,
        offsetY: clip.offsetY,
      },
      follow: clip.followCursor,
    });
    cursor = clipEnd;
  }
  if (cursor < durMs) {
    blocks.push({
      startMs: cursor,
      endMs: durMs,
      base: scene.screenTransform,
      follow: scene.followCursor,
    });
  }

  // Attach cursor samples to follow blocks. Samples are scene-relative
  // and reuse the preview's exponential smoothing so preview and export
  // pan identically.
  const out: ScreenBlock[] = [];
  const srcDim = cursorTrack?.display ?? { width: canvas.width, height: canvas.height };
  for (const block of blocks) {
    const wantsFollow =
      block.follow && cursorTrack && cursorTrack.samples.length > 0;
    if (!wantsFollow) {
      out.push({
        startMs: block.startMs,
        endMs: block.endMs,
        base: { ...block.base },
        followSamples: null,
      });
      continue;
    }
    const samples: { tMs: number; offsetX: number; offsetY: number }[] = [];
    let smoothedX = 0;
    let smoothedY = 0;
    let seeded = false;
    for (let t = block.startMs; t < block.endMs; t += FOLLOW_SAMPLE_MS) {
      // Map scene-relative → screen-track local time for cursor lookup.
      const trackMs = scene.start + t - screenOffsetMs;
      const raw = cursorAtMs(cursorTrack.samples, trackMs);
      let offsetX = block.base.offsetX;
      let offsetY = block.base.offsetY;
      if (raw) {
        const target = followOffset(
          raw,
          srcDim,
          { width: targetW, height: targetH },
          block.base,
        );
        if (!seeded) {
          smoothedX = target.offsetX;
          smoothedY = target.offsetY;
          seeded = true;
        } else {
          smoothedX += FOLLOW_SMOOTH_ALPHA * (target.offsetX - smoothedX);
          smoothedY += FOLLOW_SMOOTH_ALPHA * (target.offsetY - smoothedY);
        }
        offsetX = smoothedX;
        offsetY = smoothedY;
      }
      samples.push({ tMs: t, offsetX, offsetY });
    }
    out.push({
      startMs: block.startMs,
      endMs: block.endMs,
      base: { ...block.base },
      // Samples might be empty if a follow block happens to be shorter
      // than one sample tick and the cursor lookup returned null — treat
      // that as "static" so the block doesn't pay the sendcmd overhead
      // for no benefit.
      followSamples: samples.length > 0 ? samples : null,
    });
  }
  return out;
}

/**
 * Build a filter-graph fragment that produces a single concatenated
 * `[screenOut]` stream at (targetW, targetH), one block-sized piece
 * per `ScreenBlock`. Uses `split` (N-way, where N = # blocks, not
 * # cursor samples) + per-block trim/scale/overlay + `concat`.
 *
 * Follow blocks keep a single scale + single overlay for the whole
 * block duration; the overlay's `x`/`y` options are updated at each
 * cursor sample via a `sendcmd` chained in front of the overlay. This
 * keeps the filter count linear in the number of zoom clips (typically
 * ≤10 per scene), not in the number of cursor samples (hundreds to
 * thousands), which avoids the filter-graph allocator blow-up we hit
 * at v0.2.0 on long follow-cursor scenes.
 *
 * Returns null if there are no blocks (empty scene).
 */
function screenBlocksGraph(
  blocks: ScreenBlock[],
  screenIdx: number,
  targetW: number,
  targetH: number,
  suffix: string,
): { chain: string; outLabel: string } | null {
  if (blocks.length === 0) return null;
  const n = blocks.length;
  const splitLabels = Array.from({ length: n }, (_, i) => `sp${suffix}${i}`);
  // Normalize the screen input to CFR before splitting. macOS
  // ScreenCaptureKit (and Windows equivalents) record VFR — frames are
  // only emitted when pixels change. Forcing 30 fps here guarantees
  // every trim window downstream has frames to work with, even across
  // idle periods. 30 fps matches the Reels/Shorts delivery target.
  // format=yuv420p and setsar=1 pin the pixel format and sample aspect
  // ratio so scale's output-pad negotiation doesn't trip on mid-stream
  // drift (e.g. macOS VideoToolbox occasionally alternates nv12/yuv420p).
  const cfrLabel = `cfr_${suffix}`;
  const cfrChain = `[${screenIdx}:v]fps=30,format=yuv420p,setsar=1[${cfrLabel}]`;
  const splitChain =
    n === 1
      ? `[${cfrLabel}]null[${splitLabels[0]}]`
      : `[${cfrLabel}]split=${n}${splitLabels.map((l) => `[${l}]`).join('')}`;

  const blockChains: string[] = [];
  const blockOuts: string[] = [];
  for (let i = 0; i < n; i++) {
    const b = blocks[i];
    const durSec = (b.endMs - b.startMs) / 1000;
    const startSec = b.startMs / 1000;
    const trimLabel = `trm${suffix}${i}`;
    const scaleLabel = `sc${suffix}${i}`;
    const bgLabel = `bg${suffix}${i}`;
    const frLabel = `fr${suffix}${i}`;

    // Trim + PTS reset — one trim per block, not per sample.
    blockChains.push(
      `[${splitLabels[i]}]trim=start=${startSec.toFixed(3)}:` +
        `duration=${durSec.toFixed(3)},setpts=PTS-STARTPTS[${trimLabel}]`,
    );

    // Scale the trimmed stream once at the block's (constant) zoom.
    const fitFlag =
      b.base.fit === 'cover'
        ? 'force_original_aspect_ratio=increase'
        : 'force_original_aspect_ratio=decrease';
    const zoom = Math.max(0.1, b.base.zoom);
    const zW = Math.max(1, Math.round(targetW * zoom));
    const zH = Math.max(1, Math.round(targetH * zoom));

    // Build the overlay position expression. For static blocks this is
    // a constant. For follow blocks, the initial value is the first
    // sample's position and subsequent samples update x/y via sendcmd.
    const xFromOffset = (offX: number) =>
      `(${targetW}-w)/2+(${offX.toFixed(4)})*${targetW}`;
    const yFromOffset = (offY: number) =>
      `(${targetH}-h)/2+(${offY.toFixed(4)})*${targetH}`;

    if (b.followSamples && b.followSamples.length > 0) {
      // Re-base sample times to block-local seconds. sendcmd timestamps
      // are stream-time from the start of the filter's input, and after
      // setpts=PTS-STARTPTS that's 0 at the trim's first frame.
      const samples = b.followSamples;
      const baseMs = b.startMs;
      // Each sample emits one sendcmd interval combining x and y. The
      // sendcmd grammar is `INTERVAL CMD[,CMD,...]` with intervals
      // separated by `;`. Command args are plain numeric expressions
      // (no spaces, no semicolons), so no escaping is needed.
      const cmdParts: string[] = [];
      for (const s of samples) {
        const tSec = Math.max(0, (s.tMs - baseMs) / 1000).toFixed(3);
        cmdParts.push(
          `${tSec} overlay x ${xFromOffset(s.offsetX)},` +
            `overlay y ${yFromOffset(s.offsetY)}`,
        );
      }
      const cmdStr = cmdParts.join(';');
      // Plain background — no sendcmd here.
      blockChains.push(
        `color=c=black:s=${targetW}x${targetH}:d=${durSec.toFixed(3)}[${bgLabel}]`,
      );
      // sendcmd rides on the SCALED VIDEO stream, not the background.
      // The CFR chain pins the video to 30 fps; the color source defaults
      // to 25 fps. sendcmd commands fire when frames pass through it, so
      // putting it on the slower stream means commands fire at 25 Hz —
      // and at our 33 ms sample interval, more commands queue up than
      // frames can flush over the scene's runtime. The result is the
      // overlay's x/y getting permanently stuck a few hundred samples
      // behind. Riding the 30 fps video stream gives us one command per
      // output frame, exactly what we want for smooth panning.
      blockChains.push(
        `[${trimLabel}]scale=${zW}:${zH}:${fitFlag},` +
          `sendcmd=c='${cmdStr}'[${scaleLabel}]`,
      );
      // eval=frame lets the overlay re-compile x/y every frame so
      // sendcmd updates take effect. The initial x/y is the first
      // sample's position so frames before the first sendcmd tick are
      // already correctly placed.
      const first = samples[0];
      blockChains.push(
        `[${bgLabel}][${scaleLabel}]overlay=eval=frame:` +
          `x=${xFromOffset(first.offsetX)}:` +
          `y=${yFromOffset(first.offsetY)}[${frLabel}]`,
      );
    } else {
      // Static block — plain scale + plain overlay, no sendcmd.
      blockChains.push(
        `[${trimLabel}]scale=${zW}:${zH}:${fitFlag}[${scaleLabel}]`,
      );
      blockChains.push(
        `color=c=black:s=${targetW}x${targetH}:d=${durSec.toFixed(3)}[${bgLabel}]`,
      );
      blockChains.push(
        `[${bgLabel}][${scaleLabel}]overlay=` +
          `x=${xFromOffset(b.base.offsetX)}:` +
          `y=${yFromOffset(b.base.offsetY)}[${frLabel}]`,
      );
    }

    blockOuts.push(`[${frLabel}]`);
  }

  const outLabel = `segout_${suffix}`;
  const concatChain =
    n === 1
      ? `${blockOuts[0]}null[${outLabel}]`
      : `${blockOuts.join('')}concat=n=${n}:v=1:a=0[${outLabel}]`;
  const chain = [cfrChain, splitChain, ...blockChains, concatChain].join(';');
  return { chain, outLabel: `[${outLabel}]` };
}

function ffmpegBinary(): string {
  if (!ffmpegPath) throw new Error('ffmpeg binary not found');
  // In dev, ffmpegPath is absolute. In a packaged app it points inside
  // app.asar.unpacked (we'll configure electron-builder accordingly).
  return (ffmpegPath as unknown as string).replace(
    'app.asar',
    'app.asar.unpacked',
  );
}

function run(args: string[], logTag: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegBinary(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve();
      else {
        // Log the full command + full stderr so we can reproduce the
        // exact ffmpeg invocation outside Electron when a filter-graph
        // negotiation fails. The thrown Error still trims to the last
        // 400 chars for the UI toast.
        // eslint-disable-next-line no-console
        console.error(
          `[export] ffmpeg ${logTag} failed (code ${code})\n` +
            `  bin: ${ffmpegBinary()}\n` +
            `  args: ${JSON.stringify(args)}\n` +
            `  stderr:\n${stderr}`,
        );
        reject(new Error(`ffmpeg ${logTag} failed (code ${code}): ${stderr.slice(-400)}`));
      }
    });
  });
}

/**
 * Build the filter graph for one scene using the transform helper.
 * Video input indices (set by the caller) and which sources are present
 * are passed in. Produces a single `[outv]` labeled stream at canvas WxH.
 */
function sceneFilterGraph(
  scene: ExportRequest['scenes'][number],
  canvasW: number,
  canvasH: number,
  orientation: ExportRequest['orientation'],
  screenIdx: number | null,
  camIdx: number | null,
  cursorTrack: ExportRequest['cursorTrack'] | undefined,
  screenOffsetMs: number,
): string {
  const layout = scene.layout;
  const durSec = (scene.end - scene.start) / 1000;
  const finalBg =
    `color=c=black:s=${canvasW}x${canvasH}:d=${durSec.toFixed(3)},format=yuv420p[canvas_bg]`;

  // Does this scene need segmentation (zoom clips or follow-cursor)? If
  // not, we take the cheap single-transform path that v0.1 shipped with.
  const hasEffects =
    scene.zoomClips.length > 0 ||
    (scene.followCursor && !!cursorTrack && cursorTrack.samples.length > 0);

  /**
   * Build the screen stream for this scene at (targetW, targetH), either
   * as a single transformedSource or as a segmented chain. Returns null
   * if `screenIdx` is null (layouts that don't render the screen).
   */
  const buildScreenStream = (
    targetW: number,
    targetH: number,
    suffix: string,
  ): { chain: string; outLabel: string } | null => {
    if (screenIdx === null) return null;
    if (!hasEffects) {
      return transformedSource(
        `${screenIdx}:v`,
        targetW,
        targetH,
        scene.screenTransform,
        durSec,
        suffix,
      );
    }
    const blocks = planScreenBlocks(
      scene,
      { width: canvasW, height: canvasH },
      cursorTrack,
      screenOffsetMs,
      targetW,
      targetH,
    );
    return (
      screenBlocksGraph(blocks, screenIdx, targetW, targetH, suffix) ??
      transformedSource(
        `${screenIdx}:v`,
        targetW,
        targetH,
        scene.screenTransform,
        durSec,
        suffix,
      )
    );
  };

  if (layout === 'screen-only' && screenIdx !== null) {
    const stream = buildScreenStream(canvasW, canvasH, 'screen');
    if (!stream) return `${finalBg};[canvas_bg]copy[outv]`;
    return `${stream.chain};${stream.outLabel}copy[outv]`;
  }
  if ((layout === 'cam-only' || layout === 'mobile-only') && camIdx !== null) {
    const { chain, outLabel } = transformedSource(
      `${camIdx}:v`,
      canvasW,
      canvasH,
      scene.camTransform,
      durSec,
      'cam',
    );
    return `${chain};${outLabel}copy[outv]`;
  }
  if (layout === 'split-horizontal' && screenIdx !== null && camIdx !== null) {
    const isPortrait = orientation === 'portrait' || orientation === 'square';
    const halfW = isPortrait ? canvasW : Math.floor(canvasW / 2);
    const halfH = isPortrait ? Math.floor(canvasH / 2) : canvasH;
    const s = buildScreenStream(halfW, halfH, 'screen');
    if (!s) return `${finalBg};[canvas_bg]copy[outv]`;
    const c = transformedSource(`${camIdx}:v`, halfW, halfH, scene.camTransform, durSec, 'cam');
    const layoutFilter = isPortrait
      ? `${s.outLabel}${c.outLabel}vstack=inputs=2[outv]`
      : `${s.outLabel}${c.outLabel}hstack=inputs=2[outv]`;
    return `${s.chain};${c.chain};${layoutFilter}`;
  }
  if (layout === 'screen-with-bubble' && screenIdx !== null && camIdx !== null) {
    const bubble = Math.floor(Math.min(canvasW, canvasH) * 0.25);
    const margin = Math.floor(Math.min(canvasW, canvasH) * 0.04);
    const x =
      scene.bubbleCorner === 'tr' || scene.bubbleCorner === 'br'
        ? canvasW - bubble - margin
        : margin;
    const y =
      scene.bubbleCorner === 'bl' || scene.bubbleCorner === 'br'
        ? canvasH - bubble - margin
        : margin;
    const s = buildScreenStream(canvasW, canvasH, 'screen');
    if (!s) return `${finalBg};[canvas_bg]copy[outv]`;
    const c = transformedSource(
      `${camIdx}:v`,
      bubble,
      bubble,
      scene.camTransform,
      durSec,
      'cam',
    );
    // Circular bubble. Build a separate grayscale mask (white inside the
    // inscribed circle, black outside) via geq on a solid color source,
    // then alphamerge it onto the bubble composite. This is more robust
    // than feeding geq a yuva420p input and overriding only alpha —
    // ffmpeg's option parser has surprising behavior around quoted
    // expressions, and geq always needs one of lum/cb/cr/r/g/b set
    // anyway. alphamerge takes input #2's luma as input #1's alpha.
    // Final overlay uses format=auto so the transparent corners let
    // the screen layer show through, matching the editor's circular
    // preview. libx264 flattens the alpha at encode time via -pix_fmt.
    const maskChain =
      `color=c=black:s=${bubble}x${bubble}:d=${durSec.toFixed(3)},` +
      `geq=lum='if(lte(hypot(X-W/2,Y-H/2),W/2),255,0)'[circle_mask];` +
      `${c.outLabel}[circle_mask]alphamerge[cam_circle]`;
    // White ring around the bubble, matching the preview's
    // rgba(255,255,255,0.9) + lineWidth = max(2, bubble*0.02) stroke.
    // Canvas strokes are centered on the path (half inside, half
    // outside the radius). We place the ring fully inside the bubble
    // box (band: r ∈ [W/2 - LW, W/2]) so we don't need to enlarge the
    // overlay rect — within 1 px of preview for realistic bubble sizes.
    // Alpha ≈ 230 = 255 * 0.9 to match the 90% opacity.
    const lineWidth = Math.max(2, Math.round(bubble * 0.02));
    const innerR = bubble / 2 - lineWidth;
    const outerR = bubble / 2;
    const ringAlpha = 230;
    const ringChain =
      `color=c=black:s=${bubble}x${bubble}:d=${durSec.toFixed(3)},` +
      `geq=lum='if(between(hypot(X-W/2,Y-H/2),${innerR.toFixed(1)},${outerR.toFixed(1)}),${ringAlpha},0)'[ring_mask];` +
      `color=c=white:s=${bubble}x${bubble}:d=${durSec.toFixed(3)}[ring_src];` +
      `[ring_src][ring_mask]alphamerge[ring];` +
      `[cam_circle][ring]overlay=0:0:format=auto[bubble_final]`;
    return (
      `${s.chain};${c.chain};${maskChain};${ringChain};` +
      `${s.outLabel}[bubble_final]overlay=${x}:${y}:format=auto[outv]`
    );
  }
  // Fallback — solid black.
  return `${finalBg};[canvas_bg]copy[outv]`;
}

async function renderScene(
  scene: ExportRequest['scenes'][number],
  req: ExportRequest,
  workDir: string,
): Promise<string> {
  const canvasW = req.canvas.width;
  const canvasH = req.canvas.height;
  const durS = (scene.end - scene.start) / 1000;
  const screenTrack = req.tracks.find((t) => t.id === 'screen');
  const camTrack = req.tracks.find((t) => t.id === 'laptop-cam');
  const audioTrack = req.tracks.find((t) => t.id === scene.audioSource);

  const outFile = path.join(workDir, `${scene.id}.mp4`);
  const args: string[] = ['-y'];

  // Video inputs — trimmed at input with -ss / -t.
  const inputTrim = (track: { offsetMs: number; filePath?: string }) => {
    // Map scene-output time to track-local time.
    const localStart = Math.max(0, (scene.start - track.offsetMs) / 1000);
    return ['-ss', String(localStart), '-t', String(durS), '-i', track.filePath ?? ''];
  };

  // mobile-only always uses the mobile-cam track. Split and bubble let the
  // user pick between cam (laptop) and mobile via scene.secondarySource;
  // fall back to whichever exists if the pick's track is absent.
  const mobileTrack = req.tracks.find((t) => t.id === 'mobile-cam');
  const camSourceTrack = (() => {
    if (scene.layout === 'mobile-only') return mobileTrack ?? camTrack;
    if (
      scene.layout === 'split-horizontal' ||
      scene.layout === 'screen-with-bubble'
    ) {
      return scene.secondarySource === 'mobile'
        ? mobileTrack ?? camTrack
        : camTrack ?? mobileTrack;
    }
    return camTrack;
  })();

  let screenIdx: number | null = null;
  let camIdx: number | null = null;
  let nextIdx = 0;
  if (
    screenTrack?.filePath &&
    scene.layout !== 'cam-only' &&
    scene.layout !== 'mobile-only'
  ) {
    args.push(...inputTrim(screenTrack));
    screenIdx = nextIdx++;
  }
  if (camSourceTrack?.filePath && scene.layout !== 'screen-only') {
    args.push(...inputTrim(camSourceTrack));
    camIdx = nextIdx++;
  }

  let audioFilter = '';
  if (audioTrack?.filePath) {
    args.push(...inputTrim(audioTrack));
    audioFilter = `[${nextIdx}:a]aresample=44100,aformat=channel_layouts=stereo[outa]`;
  }

  const videoFilter = sceneFilterGraph(
    scene,
    canvasW,
    canvasH,
    req.orientation,
    screenIdx,
    camIdx,
    req.cursorTrack,
    screenTrack?.offsetMs ?? 0,
  );
  const filter = audioFilter ? `${videoFilter};${audioFilter}` : videoFilter;

  args.push('-filter_complex', filter, '-map', '[outv]');
  if (audioFilter) args.push('-map', '[outa]');

  args.push(
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-pix_fmt', 'yuv420p',
    '-r', '30',
  );
  if (audioFilter) args.push('-c:a', 'aac', '-b:a', '192k');
  else args.push('-an');
  args.push('-movflags', '+faststart', outFile);

  await run(args, `scene ${scene.id}`);
  return outFile;
}

/**
 * Expand a scene into a list of trim-free sub-scenes that together cover
 * everything except the cut ranges. Each sub-scene inherits the parent's
 * layout/transforms/zoom clips, with clips clamped or dropped if they
 * fall outside the surviving range. Returns [scene] unchanged if the
 * scene has no trim clips.
 *
 * Why pre-split rather than teach the filter graph about trims? The
 * per-scene graph already does enough work. Treating each surviving
 * range as an independent "scene" reuses the entire render pipeline —
 * concat demuxer then stitches the sub-files just like it already does
 * for scene boundaries.
 */
function splitSceneByTrims(
  scene: ExportRequest['scenes'][number],
): ExportRequest['scenes'] {
  if (!scene.trimClips || scene.trimClips.length === 0) return [scene];
  const trims = [...scene.trimClips]
    .sort((a, b) => a.start - b.start)
    .map((t) => ({
      start: Math.max(scene.start, t.start),
      end: Math.min(scene.end, t.end),
    }))
    .filter((t) => t.end > t.start);

  // Produce surviving ranges: gaps between the sorted trims, clamped to
  // the scene bounds. Fencepost at scene.start and scene.end.
  const surviving: Array<{ start: number; end: number }> = [];
  let cursor = scene.start;
  for (const t of trims) {
    if (t.start > cursor) surviving.push({ start: cursor, end: t.start });
    cursor = Math.max(cursor, t.end);
  }
  if (cursor < scene.end) surviving.push({ start: cursor, end: scene.end });

  return surviving.map((range, i) => ({
    ...scene,
    id: `${scene.id}__trim${i}`,
    start: range.start,
    end: range.end,
    // Clip zoom clips to the surviving range. A zoom overlapping the
    // boundary keeps the overlapping portion; a zoom fully inside a
    // trim is dropped.
    zoomClips: scene.zoomClips
      .map((c) => ({
        ...c,
        start: Math.max(c.start, range.start),
        end: Math.min(c.end, range.end),
      }))
      .filter((c) => c.end > c.start),
    // trimClips are consumed by the split — no need to pass them
    // downstream to the renderer.
    trimClips: [],
  }));
}

export async function exportProject(req: ExportRequest): Promise<{ outputPath: string }> {
  if (req.scenes.length === 0) throw new Error('no scenes to export');
  if (!req.outputPath) throw new Error('outputPath required');

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'threelane-export-'));
  const sceneFiles: string[] = [];
  try {
    // Expand each scene into trim-free sub-scenes. The renderer only
    // ever sees scenes with zero trimClips after this.
    const expanded = req.scenes.flatMap(splitSceneByTrims);
    if (expanded.length === 0) {
      throw new Error('every scene is fully trimmed — nothing to export');
    }
    for (const scene of expanded) {
      sceneFiles.push(await renderScene(scene, req, workDir));
    }

    // Concat via demuxer — write a list file, pass to ffmpeg.
    const listFile = path.join(workDir, 'concat.txt');
    await fs.writeFile(
      listFile,
      sceneFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'),
      'utf8',
    );

    await fs.mkdir(path.dirname(req.outputPath), { recursive: true });
    await run(
      ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', req.outputPath],
      'concat',
    );

    return { outputPath: req.outputPath };
  } finally {
    // Best-effort cleanup.
    try {
      await fs.rm(workDir, { recursive: true, force: true });
    } catch {}
  }
}
