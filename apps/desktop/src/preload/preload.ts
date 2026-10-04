// Sandboxed preload: exposes the narrow `window.sem` bridge. No Node APIs reach the renderer.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { CH, type SemBridge } from "../shared/ipc.ts";

const bridge: SemBridge = {
  api: (req) => ipcRenderer.invoke(CH.api, req),
  download: (path, opts) => ipcRenderer.invoke(CH.download, path, opts),
  upload: (path, opts) => ipcRenderer.invoke(CH.upload, path, opts),
  saveFile: (opts) => ipcRenderer.invoke(CH.saveFile, opts),
  openFile: (opts) => ipcRenderer.invoke(CH.openFile, opts),
  openExternal: (url) => ipcRenderer.invoke(CH.openExternal, url),
  revealPath: (p) => ipcRenderer.invoke(CH.revealPath, p),
  info: () => ipcRenderer.invoke(CH.info),
  onMenu: (cb) => {
    const h = (_e: IpcRendererEvent, action: string) => cb(action);
    ipcRenderer.on(CH.menu, h);
    return () => { ipcRenderer.removeListener(CH.menu, h); };
  },
};

contextBridge.exposeInMainWorld("sem", bridge);
