const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ebLauncher", {
  readCreds: () => ipcRenderer.invoke("eb:read-creds"),
  startScript: (payload) => ipcRenderer.invoke("eb:start-script", payload),
  stopScript: () => ipcRenderer.invoke("eb:stop-script"),
  continueScript: () => ipcRenderer.invoke("eb:continue-script"),
  onLog: (cb) => ipcRenderer.on("eb:log", (_evt, text) => cb(text)),
  onDone: (cb) => ipcRenderer.on("eb:done", (_evt, data) => cb(data)),
  onPaused: (cb) => ipcRenderer.on("eb:paused", (_evt, data) => cb(data)),
});
