import { contextBridge, ipcRenderer } from 'electron';

/**
 * Renderer-facing API. The renderer never imports electron directly —
 * everything it's allowed to do sits on `window.threelane`.
 */
contextBridge.exposeInMainWorld('threelane', {
  platform: 'electron' as const,
  version: '0.1.0',
  recorder: {
    listScreenSources: () => ipcRenderer.invoke('recorder:listScreenSources'),
    startProject: () => ipcRenderer.invoke('recorder:startProject'),
    writeTrackChunk: (
      projectId: string,
      trackId: string,
      mimeType: string,
      chunk: ArrayBuffer,
    ) =>
      ipcRenderer.invoke('recorder:writeTrackChunk', {
        projectId,
        trackId,
        mimeType,
        chunk,
      }),
    finalizeTrack: (projectId: string, trackId: string) =>
      ipcRenderer.invoke('recorder:finalizeTrack', { projectId, trackId }),
    finalizeProject: (projectId: string, manifest: unknown) =>
      ipcRenderer.invoke('recorder:finalizeProject', { projectId, manifest }),
    startCursorTracking: (
      projectId: string,
      startedAtMs: number,
      screenSourceId: string | null,
    ) =>
      ipcRenderer.invoke('recorder:startCursorTracking', {
        projectId,
        startedAtMs,
        screenSourceId,
      }),
    stopCursorTracking: (projectId: string) =>
      ipcRenderer.invoke('recorder:stopCursorTracking', projectId),
  },
  editor: {
    listProjects: () => ipcRenderer.invoke('editor:listProjects'),
    openProject: (id: string) => ipcRenderer.invoke('editor:openProject', id),
    deleteProject: (id: string) => ipcRenderer.invoke('editor:deleteProject', id),
    exportProject: (req: unknown) => ipcRenderer.invoke('editor:exportProject', req),
  },
  companion: {
    start: () => ipcRenderer.invoke('companion:start'),
    stop: () => ipcRenderer.invoke('companion:stop'),
    getInfo: () => ipcRenderer.invoke('companion:getInfo'),
    setCurrentProject: (projectId: string | null) =>
      ipcRenderer.invoke('companion:setCurrentProject', projectId),
    broadcastStart: (startAtMs: number, projectId: string) =>
      ipcRenderer.invoke('companion:broadcastStart', { startAtMs, projectId }),
    broadcastStop: () => ipcRenderer.invoke('companion:broadcastStop'),
    waitForUploads: (deviceIds: string[]) =>
      ipcRenderer.invoke('companion:waitForUploads', deviceIds),
    onDeviceEvent: (handler: (evt: unknown) => void) => {
      const listener = (_e: unknown, evt: unknown) => handler(evt);
      ipcRenderer.on('companion:device-event', listener);
      return () => ipcRenderer.off('companion:device-event', listener);
    },
    sendToDevice: (deviceId: string, msg: unknown) =>
      ipcRenderer.invoke('companion:sendToDevice', { deviceId, msg }),
  },
});
