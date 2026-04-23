import type { CursorTrack, TrackKind } from '@/platform';

/**
 * Editor-internal data model. Distinct from the on-disk manifest — this
 * carries extra render-only state (object URLs, decoded durations) that
 * we never serialize.
 */

export type Orientation = 'portrait' | 'landscape' | 'square';

export interface CanvasSize {
  width: number;
  height: number;
  orientation: Orientation;
}

export const CANVAS_PRESETS: Record<Orientation, CanvasSize> = {
  portrait: { width: 1080, height: 1920, orientation: 'portrait' },
  landscape: { width: 1920, height: 1080, orientation: 'landscape' },
  square: { width: 1080, height: 1080, orientation: 'square' },
};

export type Layout =
  | 'screen-only'
  | 'cam-only'
  | 'mobile-only'
  | 'split-horizontal' // top/bottom on portrait, left/right on landscape
  | 'screen-with-bubble';

export type BubbleCorner = 'tl' | 'tr' | 'bl' | 'br';

/**
 * How a source video is placed inside its target rect (the full canvas,
 * the top half, the bubble, etc.). Keeps the source separable from the
 * layout logic so the user can frame a landscape screen inside a portrait
 * canvas independently of which layout it's sitting in.
 */
export interface SourceTransform {
  /** contain = letterbox to fit, cover = fill + crop overflow. */
  fit: 'contain' | 'cover';
  /** Extra zoom multiplied on top of fit. 1 = no zoom. Range ~0.5..3.
   *  This is the scene-wide baseline — per-clip zoom effects override it
   *  for their time range. */
  zoom: number;
  /** Pan offset as a fraction of the target rect's width/height. */
  offsetX: number;
  offsetY: number;
}

export const DEFAULT_TRANSFORM: SourceTransform = {
  fit: 'contain',
  zoom: 1,
  offsetX: 0,
  offsetY: 0,
};

export const DEFAULT_CAM_TRANSFORM: SourceTransform = {
  // Cam is almost always shot portrait-ish or close to 1:1 — cover reads
  // more naturally than letterbox.
  fit: 'cover',
  zoom: 1,
  offsetX: 0,
  offsetY: 0,
};

/**
 * A zoom-in effect clip on the timeline, applied to the screen track.
 * While the playhead is inside [start, end] the screen's zoom is
 * replaced by `zoom`, and — if `followCursor` is on — the pan offset is
 * overridden each frame to track the recorded cursor. Outside the range,
 * the scene's base `screenTransform` applies untouched.
 *
 * One day we'll add ramp-in/ramp-out animations (start at 1×, ease to
 * `zoom`, ease back). For v0.2.0 the transition is instant — keeps the
 * math simple and lets us nail the core UX first.
 */
export interface ZoomClip {
  id: string;
  /** Output-time ms, scene-relative? No — absolute project time, same
   *  clock as `Scene.start` / `Scene.end`. Makes it trivial to resolve
   *  the active clip from a playhead reading. */
  start: number;
  end: number;
  /** Absolute zoom (1 = no zoom, 2 = 2×, …). Not multiplied against the
   *  scene baseline — this REPLACES `screenTransform.zoom` while the
   *  clip is active. Range kept in UI: 1..4. */
  zoom: number;
  /** Track the recorded cursor with the pan offset while the clip is
   *  active. No effect if the project has no cursor track. */
  followCursor: boolean;
  /** Manual pan override when followCursor is off. Fraction of target
   *  rect, same convention as SourceTransform. */
  offsetX: number;
  offsetY: number;
}

export const DEFAULT_ZOOM_CLIP_ZOOM = 2;

export function genZoomClipId(): string {
  return `zoom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * A "cut" range on the timeline. Output-time ms, same clock as scenes
 * and zoom clips. During playback the preview skips over [start, end];
 * the exporter omits the range from the final MP4 so the output
 * duration shrinks by sum(trim durations). Trim clips live on a scene
 * so splitting / deleting a scene keeps them sensible — a clip fully
 * inside a scene travels with that scene.
 */
export interface TrimClip {
  id: string;
  start: number;
  end: number;
}

export function genTrimClipId(): string {
  return `trim-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Which source "slot" a transform applies to inside a scene. */
export type SourceRole = 'screen' | 'cam';

/**
 * Which track fills the non-screen slot in `split-horizontal` and
 * `screen-with-bubble`. `cam` = laptop webcam track; `mobile` = phone
 * mobile-cam track. The same `camTransform` applies to whichever is
 * selected — they're conceptually interchangeable "second camera" slots.
 * Ignored for layouts that don't have a secondary slot (screen-only etc.).
 */
export type SecondarySource = 'cam' | 'mobile';

export interface EditorTrack {
  id: TrackKind;
  kind: TrackKind;
  /** One MediaSource per track; set in the track pool component. */
  url: string;
  mimeType: string;
  /** Wall-clock ms when recording began — determines timeline placement. */
  startedAtMs: number;
  /** Loaded lazily from the <video>/<audio> element. */
  durationMs: number;
  hasVideo: boolean;
  hasAudio: boolean;
}

export interface Scene {
  id: string;
  /** Output-time ms — always tile contiguously from 0 to end-of-project. */
  start: number;
  end: number;
  layout: Layout;
  bubbleCorner: BubbleCorner;
  /** Which track fills the cam slot for split/bubble layouts. */
  secondarySource: SecondarySource;
  /** TrackKind of the audio source; must be a track with hasAudio. */
  audioSource: TrackKind | null;
  /** Per-source placement. Unused roles in the current layout are ignored
   *  at render time but kept around so toggling layouts preserves framing. */
  screenTransform: SourceTransform;
  camTransform: SourceTransform;
  /** Track the recorded cursor with the screen's pan offset for the whole
   *  scene. Most useful when `screenTransform` is cropping the source
   *  (fit=cover, or zoom > 1) — the user doesn't want to chase the cursor
   *  out of frame. No effect without a cursor track. Newly-added zoom
   *  clips inherit this value as their own `followCursor` on creation. */
  followCursor: boolean;
  /** Zoom effect clips living on this scene's time range. Each defines a
   *  time window during which the screen track is zoomed/panned
   *  differently from the scene baseline. Empty = no effects. */
  zoomClips: ZoomClip[];
  /** Cut ranges living on this scene's time range. Preview skips over
   *  them; exporter omits them from the output. Empty = full scene plays. */
  trimClips: TrimClip[];
}

export interface EditorProject {
  id: string;
  name?: string;
  location: string;
  createdAtMs: number;
  canvas: CanvasSize;
  tracks: EditorTrack[];
  scenes: Scene[];
  /** Derived: min of track.startedAtMs — treat as output t=0. */
  sessionStartMs: number;
  /** Derived: max (startedAtMs + durationMs) - sessionStartMs. */
  totalDurationMs: number;
  /** Present only if the recording captured a cursor track. */
  cursorTrack?: CursorTrack;
  /** Project-wide toggle: draw a stylised high-contrast cursor on top of
   *  the composite so the OS cursor stays readable after downscaling to
   *  the output canvas. No effect without `cursorTrack`. */
  showCursorOverlay: boolean;
}

export function genSceneId(): string {
  return `scene-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}
