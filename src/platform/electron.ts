import type {
  CompanionDeviceEvent,
  CompanionInfo,
  ExportRequest,
  ExportResult,
  LoadedProject,
  Platform,
  ProjectHandle,
  ProjectManifest,
  ScreenSource,
  TrackKind,
} from './types';

/**
 * Electron platform. Delegates all file-system work to the main process via
 * the IPC bridge exposed on `window.threelane`. The renderer never touches
 * `fs` directly.
 */

declare global {
  interface Window {
    threelane?: {
      platform: 'electron';
      version: string;
      recorder: {
        listScreenSources: () => Promise<ScreenSource[]>;
        startProject: () => Promise<ProjectHandle>;
        writeTrackChunk: (
          projectId: string,
          trackId: TrackKind,
          mimeType: string,
          chunk: ArrayBuffer,
        ) => Promise<void>;
        finalizeTrack: (
          projectId: string,
          trackId: TrackKind,
        ) => Promise<string>;
        finalizeProject: (
          projectId: string,
          manifest: ProjectManifest,
        ) => Promise<string>;
        startCursorTracking: (
          projectId: string,
          startedAtMs: number,
          screenSourceId: string | null,
        ) => Promise<string | null>;
        stopCursorTracking: (projectId: string) => Promise<string | null>;
      };
      editor: {
        listProjects: () => Promise<
          { id: string; name?: string; location: string; createdAtMs: number }[]
        >;
        openProject: (id: string) => Promise<LoadedProject | null>;
        deleteProject: (id: string) => Promise<void>;
        exportProject: (req: ExportRequest) => Promise<ExportResult>;
      };
      companion: {
        start: () => Promise<CompanionInfo>;
        stop: () => Promise<void>;
        getInfo: () => Promise<CompanionInfo | null>;
        setCurrentProject: (projectId: string | null) => Promise<void>;
        broadcastStart: (startAtMs: number, projectId: string) => Promise<void>;
        broadcastStop: () => Promise<void>;
        waitForUploads: (
          deviceIds: string[],
        ) => Promise<{ id: string; file: string }[]>;
        onDeviceEvent: (
          handler: (evt: CompanionDeviceEvent) => void,
        ) => () => void;
        sendToDevice: (deviceId: string, msg: unknown) => Promise<boolean>;
      };
    };
  }
}

function bridge() {
  const b = window.threelane;
  if (!b) throw new Error('Electron bridge not found (is preload loaded?)');
  return b;
}

export const electronPlatform: Platform = {
  kind: 'electron',

  listScreenSources() {
    return bridge().recorder.listScreenSources();
  },

  async captureScreen(sourceId: string | null): Promise<MediaStream> {
    if (!sourceId) throw new Error('sourceId required on Electron');
    // Chromium-specific constraint that routes getUserMedia to desktopCapturer.
    return navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        // @ts-expect-error — Chromium-only constraint, not in lib.dom.d.ts
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
        },
      },
    });
  },

  startProject() {
    return bridge().recorder.startProject();
  },

  writeTrackChunk(projectId, trackId, mimeType, chunk) {
    return bridge().recorder.writeTrackChunk(projectId, trackId, mimeType, chunk);
  },

  finalizeTrack(projectId, trackId) {
    return bridge().recorder.finalizeTrack(projectId, trackId);
  },

  finalizeProject(projectId, manifest) {
    return bridge().recorder.finalizeProject(projectId, manifest);
  },

  startCursorTracking(projectId, startedAtMs, screenSourceId) {
    return bridge().recorder.startCursorTracking(
      projectId,
      startedAtMs,
      screenSourceId,
    );
  },

  stopCursorTracking(projectId) {
    return bridge().recorder.stopCursorTracking(projectId);
  },

  companionStart() {
    return bridge().companion.start();
  },
  companionSetCurrentProject(projectId) {
    return bridge().companion.setCurrentProject(projectId);
  },
  companionBroadcastStart(startAtMs, projectId) {
    return bridge().companion.broadcastStart(startAtMs, projectId);
  },
  companionBroadcastStop() {
    return bridge().companion.broadcastStop();
  },
  companionWaitForUploads(deviceIds) {
    return bridge().companion.waitForUploads(deviceIds);
  },
  companionSubscribe(handler) {
    return bridge().companion.onDeviceEvent(handler);
  },
  companionSendToDevice(deviceId, msg) {
    return bridge().companion.sendToDevice(deviceId, msg);
  },

  listProjects() {
    return bridge().editor.listProjects();
  },

  async openProject(id?: string) {
    if (!id) throw new Error('project id required on Electron');
    return bridge().editor.openProject(id);
  },

  deleteProject(id) {
    return bridge().editor.deleteProject(id);
  },

  exportProject(req) {
    return bridge().editor.exportProject(req);
  },
};
