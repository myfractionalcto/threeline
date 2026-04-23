import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { listScreenSources } from './recorder/sources';
import {
  appendChunk,
  createProject,
  finalizeTrack,
  writeManifest,
} from './recorder/storage';
import { startCursorTracking, stopCursorTracking } from './recorder/cursor';
import { deleteProject, listProjects, openProject, projectsRoot } from './editor/projects';
import { exportProject, type ExportRequest } from './editor/export';
import {
  broadcastStart,
  broadcastStop,
  getServerInfo,
  sendToDevice,
  setCurrentProject,
  startCompanionServer,
  stopCompanionServer,
  waitForDeviceUploads,
} from './companion/server';
import { devices, type DeviceEvent } from './companion/state';
import path from 'node:path';

/**
 * All IPC surface between main and renderer lives here. The preload re-exposes
 * these channels to the renderer via contextBridge — the renderer itself
 * never sees `ipcRenderer` or `require('electron')`.
 */

export function registerIpc() {
  ipcMain.handle('recorder:listScreenSources', async () => {
    return listScreenSources();
  });

  ipcMain.handle('recorder:startProject', async () => {
    const { id, dir } = await createProject();
    return { id, location: dir };
  });

  ipcMain.handle(
    'recorder:writeTrackChunk',
    async (
      _e,
      payload: {
        projectId: string;
        trackId: string;
        mimeType: string;
        chunk: ArrayBuffer;
      },
    ) => {
      await appendChunk(payload.projectId, payload.trackId, payload.mimeType, payload.chunk);
    },
  );

  ipcMain.handle(
    'recorder:finalizeTrack',
    async (_e, payload: { projectId: string; trackId: string }) => {
      return finalizeTrack(payload.projectId, payload.trackId);
    },
  );

  ipcMain.handle(
    'recorder:finalizeProject',
    async (_e, payload: { projectId: string; manifest: unknown }) => {
      return writeManifest(payload.projectId, payload.manifest);
    },
  );

  ipcMain.handle(
    'recorder:startCursorTracking',
    async (
      _e,
      payload: {
        projectId: string;
        startedAtMs: number;
        screenSourceId: string | null;
      },
    ) => {
      const dir = path.join(projectsRoot(), payload.projectId);
      return startCursorTracking(
        payload.projectId,
        dir,
        payload.startedAtMs,
        payload.screenSourceId,
      );
    },
  );

  ipcMain.handle('recorder:stopCursorTracking', async (_e, projectId: string) => {
    return stopCursorTracking(projectId);
  });

  ipcMain.handle('editor:listProjects', async () => {
    return listProjects();
  });

  ipcMain.handle('editor:openProject', async (_e, id: string) => {
    return openProject(id);
  });

  ipcMain.handle('editor:deleteProject', async (_e, id: string) => {
    await deleteProject(id);
  });

  // --------- Companion (mobile PWA) ---------
  //
  // The companion server is started on demand when the user clicks
  // "Add phone" in the studio. Devices auto-register over WSS and the
  // registry emits events that we forward to every open renderer.

  ipcMain.handle('companion:start', async () => {
    const info = await startCompanionServer();
    return {
      url: info.url,
      urlFallback: info.urlFallback,
      hostname: info.hostname,
      port: info.port,
      ip: info.ip,
      certInstallUrl: info.certInstallUrl,
      publicCertActive: info.publicCertActive,
      devices: devices.list(),
    };
  });

  ipcMain.handle('companion:stop', async () => {
    await stopCompanionServer();
  });

  ipcMain.handle('companion:getInfo', async () => {
    const info = getServerInfo();
    if (!info) return null;
    return {
      url: info.url,
      urlFallback: info.urlFallback,
      hostname: info.hostname,
      port: info.port,
      ip: info.ip,
      certInstallUrl: info.certInstallUrl,
      publicCertActive: info.publicCertActive,
      devices: devices.list(),
    };
  });

  ipcMain.handle(
    'companion:setCurrentProject',
    async (_e, projectId: string | null) => {
      setCurrentProject(projectId);
    },
  );

  ipcMain.handle(
    'companion:broadcastStart',
    async (_e, payload: { startAtMs: number; projectId: string }) => {
      broadcastStart(payload.startAtMs, payload.projectId);
    },
  );

  ipcMain.handle('companion:broadcastStop', async () => {
    broadcastStop();
  });

  ipcMain.handle(
    'companion:waitForUploads',
    async (_e, deviceIds: string[]) => {
      return waitForDeviceUploads(deviceIds);
    },
  );

  // WebRTC live preview: renderer-driven signaling.
  //   renderer → phone: send an SDP answer / ICE candidate / preview toggle.
  //   phone → renderer: handled via the `rtc-signal` DeviceEvent below.
  ipcMain.handle(
    'companion:sendToDevice',
    async (_e, payload: { deviceId: string; msg: unknown }) => {
      return sendToDevice(payload.deviceId, payload.msg);
    },
  );

  // Fan device registry events out to all renderer windows so the studio
  // reflects joins/leaves/upload progress without polling.
  devices.on('event', (evt: DeviceEvent) => {
    for (const w of BrowserWindow.getAllWindows()) {
      try {
        w.webContents.send('companion:device-event', evt);
      } catch {
        // window may be closing
      }
    }
  });

  ipcMain.handle(
    'editor:exportProject',
    async (e, req: ExportRequest) => {
      // Ask the user where to save BEFORE we spend time rendering. If the
      // user cancels, resolve with `{ cancelled: true }` so the renderer
      // can return to idle instead of surfacing an error.
      const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
      const safeName = (req.projectName || req.projectId)
        .replace(/[\/\\:*?"<>|]/g, '_')
        .trim() || 'Untitled';
      const defaultPath = path.join(
        app.getPath('videos'),
        `${safeName}.mp4`,
      );
      const result = win
        ? await dialog.showSaveDialog(win, {
            title: 'Export video',
            defaultPath,
            filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
          })
        : await dialog.showSaveDialog({
            title: 'Export video',
            defaultPath,
            filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
          });
      if (result.canceled || !result.filePath) {
        return { cancelled: true as const };
      }

      // Rewrite renderer-visible threelane-file:// URLs back to absolute
      // paths that ffmpeg can read. Decode first — older manifests stored
      // the `file` field as an absolute path, so the URL can contain
      // %2F-encoded slashes that path.basename would otherwise miss.
      const resolved: ExportRequest = {
        ...req,
        outputPath: result.filePath,
        tracks: req.tracks.map((t) => ({
          ...t,
          filePath: t.filePath
            ? path.join(
                projectsRoot(),
                req.projectId,
                path.basename(decodeURIComponent(t.filePath)),
              )
            : undefined,
        })),
      };
      try {
        const res = await exportProject(resolved);
        shell.showItemInFolder(res.outputPath);
        return res;
      } catch (err) {
        // Electron wraps the thrown Error with "Error invoking remote
        // method ...", which hides the real ffmpeg stderr from the UI.
        // Log the full detail to main console and rethrow a plain Error
        // whose message preserves ffmpeg's output for the renderer.
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[export] failed:', err);
        throw new Error(msg);
      }
    },
  );
}

