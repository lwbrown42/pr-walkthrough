import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type PreloadApi } from '../shared/api'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: PreloadApi = {
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  saveSettings: (patch) => ipcRenderer.invoke(IPC.saveSettings, patch),
  pickRepo: () => ipcRenderer.invoke(IPC.pickRepo),
  openTarget: (req) => ipcRenderer.invoke(IPC.openTarget, req),
  generate: (target) => ipcRenderer.invoke(IPC.generate, target),
  cancelGenerate: () => ipcRenderer.invoke(IPC.cancelGenerate),
  onGenerateProgress: (cb) => subscribe(IPC.generateProgress, cb),
  ask: (req) => ipcRenderer.invoke(IPC.ask, req),
  onChatText: (cb) => subscribe(IPC.chatText, cb),
  getFixture: () => ipcRenderer.invoke(IPC.getFixture),
  readFile: (req) => ipcRenderer.invoke(IPC.readFile, req),
  openPr: () => ipcRenderer.invoke(IPC.openPr),
  getRunLog: () => ipcRenderer.invoke(IPC.getRunLog),
  getReviewUsage: () => ipcRenderer.invoke(IPC.getReviewUsage),
  listReviews: () => ipcRenderer.invoke(IPC.listReviews),
  reopenReview: (id) => ipcRenderer.invoke(IPC.reopenReview, id),
  saveReviewState: (req) => ipcRenderer.invoke(IPC.saveReviewState, req),
  deleteReview: (id) => ipcRenderer.invoke(IPC.deleteReview, id),
  restoreReview: (review) => ipcRenderer.invoke(IPC.restoreReview, review),
  checkReviewUpdates: (id) => ipcRenderer.invoke(IPC.checkReviewUpdates, id)
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.api = api
}
