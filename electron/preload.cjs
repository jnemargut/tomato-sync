// Safe bridge between the renderer window and the main process.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  getState: () => ipcRenderer.invoke("state:get"),
  syncNow: () => ipcRenderer.invoke("sync:now"),
  syncApp: (id) => ipcRenderer.invoke("sync:app", id),
  ejectNow: () => ipcRenderer.invoke("eject:now"),
  openLink: (id) => ipcRenderer.invoke("open:link", id),
  setConfig: (patch) => ipcRenderer.invoke("config:set", patch),
  onState: (cb) => ipcRenderer.on("state", (_e, s) => cb(s)),
  onLog: (cb) => ipcRenderer.on("log", (_e, line) => cb(line)),
});
