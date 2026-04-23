/**
 * Platform adapter boundary.
 *
 * The UI only talks to `Platform`. We have two implementations — Electron
 * (real file-system writes via IPC) and Web (blob downloads on stop, used
 * for fast iteration in Chrome before packaging a .dmg). The UI must not
 * know which one it's talking to.
 */

export type PlatformKind = 'electron' | 'web';

export interface ScreenSource {
  id: string;
  name: string;
  thumbnailDataUrl?: string;
}

export interface ProjectHandle {
  id: string;
  /** Human-readable location for display — a path on Electron, "browser
   *  downloads" on web. */
  location: string;
}

export type TrackKind = 'screen' | 'laptop-cam' | 'laptop-mic' | 'mobile-cam';

// --- Companion (mobile PWA) ---

export type CompanionDevicePhase =
  | 'connected'
  | 'ready'
  | 'recording'
  | 'uploading'
  | 'done';

export interface CompanionDevice {
  id: string;
  label: string;
  ua: string;
  phase: CompanionDevicePhase;
  clockOffsetMs: number;
  uploadedBytes?: number;
  uploadTotalBytes?: number;
  uploadedFile?: string;
  durationMs?: number;
  mimeType?: string;
}

export type CompanionDeviceEvent =
  | { type: 'joined'; device: CompanionDevice }
  | { type: 'left'; id: string }
  | { type: 'phase'; id: string; phase: CompanionDevicePhase }
  | { type: 'offset'; id: string; clockOffsetMs: number }
  | {
      type: 'upload-progress';
      id: string;
      uploadedBytes: number;
      uploadTotalBytes?: number;
    }
  | {
      type: 'upload-done';
      id: string;
      file: string;
      durationMs: number;
      mimeType: string;
    }
  /** Phone-originated WebRTC SDP / ICE blob. Forwarded verbatim — the
   *  studio-side peer connection interprets it. */
  | { type: 'rtc-signal'; id: string; payload: unknown };

export interface CompanionInfo {
  /** Primary URL for the phone — a `*.local-ip.sh` hostname when the public
   *  cert is active (no install needed), otherwise the raw-IP URL. */
  url: string;
  /** Raw-IP URL (e.g. `https://192.168.1.23:47878`). Surfaced so the PWA
   *  can fall back here if DNS rebinding protection blocks the hostname. */
  urlFallback: string;
  /** Just the hostname portion of `url` (no scheme/port). Null when we're
   *  serving from the raw-IP URL. */
  hostname: string | null;
  port: number;
  ip: string;
  /** URL the phone visits to install the local CA cert — only relevant
   *  when `publicCertActive === false` or the user's network blocks the
   *  public-cert hostname. */
  certInstallUrl: string;
  /** True when the `*.local-ip.sh` cert loaded and we're serving the nicer
   *  "no install needed" URL. False means we're back on the legacy raw-IP +
   *  CA-install flow. The UI switches its hint copy on this flag. */
  publicCertActive: boolean;
  devices: CompanionDevice[];
}

export interface TrackManifestEntry {
  id: TrackKind;
  mimeType: string;
  startedAtMs: number; // wall-clock ms when recording began
  durationMs: number;
  bytes: number;
  file: string; // filename inside the project folder
}

export interface ProjectManifest {
  id: string;
  /** User-provided name. Falls back to a timestamp label in the UI if blank. */
  name?: string;
  createdAtMs: number;
  canvas: { width: number; height: number; orientation: 'portrait' | 'landscape' | 'square' };
  tracks: TrackManifestEntry[];
}

export interface CursorSample {
  t: number; // ms from recording start
  x: number;
  y: number;
}

export interface CursorTrack {
  /** Source (recording) dimensions in DIP — cursor samples are in this coord space. */
  display: { width: number; height: number; scaleFactor: number };
  samples: CursorSample[];
}

export interface LoadedProject {
  manifest: ProjectManifest;
  /** Map from trackId to a playable URL (blob: on web, file:// on Electron). */
  trackUrls: Record<string, string>;
  location: string;
  /** Cursor time-series if the recording captured one (Electron-only). */
  cursorTrack?: CursorTrack;
}

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
  /** Human-readable project name. Used to seed the save dialog's default filename. */
  projectName?: string;
  canvas: { width: number; height: number };
  /** Scenes in output-time order, gap-free. */
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
    /** Baseline scene-level cursor-follow. */
    followCursor: boolean;
    /** Time-ordered, non-overlapping zoom effect clips. */
    zoomClips: ExportZoomClip[];
    /** Time-ordered, non-overlapping cut ranges the exporter must omit
     *  from the final output. Reduces the scene's effective duration. */
    trimClips: ExportTrimClip[];
  }[];
  /** The tracks used — includes the source file path (Electron) or URL (web). */
  tracks: {
    id: string;
    /** Wall-clock offset from project.sessionStartMs in ms. */
    offsetMs: number;
    durationMs: number;
    filePath?: string;
    url?: string;
  }[];
  orientation: 'portrait' | 'landscape' | 'square';
  /** Cursor samples in screen-track-local ms. Used by the exporter to
   *  compute per-segment follow-cursor offsets. */
  cursorTrack?: {
    samples: { t: number; x: number; y: number }[];
    display: { width: number; height: number };
  };
}

export type ExportResult =
  | { outputPath: string; cancelled?: false }
  | { cancelled: true };

export interface Platform {
  kind: PlatformKind;

  /** List capturable screens/windows (Electron only; web uses browser picker). */
  listScreenSources(): Promise<ScreenSource[]>;

  /** List completed projects available for editing. */
  listProjects(): Promise<
    { id: string; name?: string; location: string; createdAtMs: number }[]
  >;

  /** Open a project by id (Electron) or via user file picker (web). */
  openProject(id?: string): Promise<LoadedProject | null>;

  /** Delete a project and all its files. No-op on web (nothing persisted). */
  deleteProject(id: string): Promise<void>;

  /** Export a project to MP4 (Electron) or webm (web fallback). */
  exportProject(req: ExportRequest): Promise<ExportResult>;

  /** Build a MediaStream for a chosen screen source. Web ignores `sourceId`
   *  and uses `getDisplayMedia` which shows the browser's native picker. */
  captureScreen(sourceId: string | null): Promise<MediaStream>;

  /** Create a project folder and return its handle. */
  startProject(): Promise<ProjectHandle>;

  /** Stream a single chunk of a track to persistent storage. */
  writeTrackChunk(
    projectId: string,
    trackId: TrackKind,
    mimeType: string,
    chunk: ArrayBuffer,
  ): Promise<void>;

  /** Flush buffers and finalize one track. Returns the written file path. */
  finalizeTrack(projectId: string, trackId: TrackKind): Promise<string>;

  /** Write manifest.json and reveal the folder to the user. */
  finalizeProject(projectId: string, manifest: ProjectManifest): Promise<string>;

  /**
   * Start recording the global cursor position alongside a screen capture.
   * Electron polls at ~30 Hz and writes cursor.jsonl into the project folder.
   * Web is a no-op — browsers can't see the cursor outside the tab.
   */
  startCursorTracking(
    projectId: string,
    startedAtMs: number,
    screenSourceId: string | null,
  ): Promise<string | null>;

  /** Flush and close cursor.jsonl. Returns the filename (relative) or null. */
  stopCursorTracking(projectId: string): Promise<string | null>;

  // --- Companion (mobile phone over WiFi) ---
  //
  // Electron starts an HTTPS+WSS server and broadcasts recording cues.
  // Web mode is a no-op — a browser tab can't open a server.

  /** Boot the companion server (idempotent). Returns connection info. */
  companionStart(): Promise<CompanionInfo | null>;

  /** Tell connected phones which project they're recording into. */
  companionSetCurrentProject(projectId: string | null): Promise<void>;

  /** Broadcast start/stop to all phones. */
  companionBroadcastStart(startAtMs: number, projectId: string): Promise<void>;
  companionBroadcastStop(): Promise<void>;

  /** Wait until every device in `deviceIds` has uploaded its clip. */
  companionWaitForUploads(deviceIds: string[]): Promise<{ id: string; file: string }[]>;

  /** Subscribe to device join/leave/upload events. Returns unsubscribe. */
  companionSubscribe(handler: (evt: CompanionDeviceEvent) => void): () => void;

  /**
   * Send an arbitrary JSON message to one connected phone. Used for
   * WebRTC signaling (SDP answer, ICE candidates) and preview enable/
   * disable commands — the studio drives the session, the phone just
   * reacts. Returns whether the message was queued.
   */
  companionSendToDevice(deviceId: string, msg: unknown): Promise<boolean>;
}
