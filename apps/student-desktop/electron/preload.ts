/**
 * Preload bridge — the ONLY surface the sandboxed renderer can reach.
 * contextIsolation + sandbox are enabled; no Node/Electron internals leak.
 */
import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type DesktopBridge } from '../src/shared/types';

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const bridge: DesktopBridge = {
  getAppInfo: () => ipcRenderer.invoke(IPC.appInfo),
  login: (email, password) => ipcRenderer.invoke(IPC.authLogin, { email, password }),
  logout: () => ipcRenderer.invoke(IPC.authLogout),
  authStatus: () => ipcRenderer.invoke(IPC.authStatus),
  listExams: () => ipcRenderer.invoke(IPC.examsList),
  getExam: (id) => ipcRenderer.invoke(IPC.examGet, { examId: id }),
  startAttempt: (examId, opts) => ipcRenderer.invoke(IPC.attemptStart, { examId, opts }),
  getAttempt: (id) => ipcRenderer.invoke(IPC.attemptGet, { attemptId: id }),
  saveAnswer: (attemptId, questionId, value) =>
    ipcRenderer.invoke(IPC.answerSave, { attemptId, questionId, value }),
  heartbeat: (attemptId) => ipcRenderer.invoke(IPC.attemptHeartbeat, { attemptId }),
  submit: (attemptId) => ipcRenderer.invoke(IPC.attemptSubmit, { attemptId }),
  reportSensor: (payload) => ipcRenderer.invoke(IPC.sensorReport, { payload }),
  updateMediaSession: (update) => ipcRenderer.invoke(IPC.mediaSession, { update }),
  getMediaToken: (attemptId) => ipcRenderer.invoke(IPC.mediaToken, { attemptId }),
  listScreenSources: () => ipcRenderer.invoke(IPC.screenSources),
  setExamMode: (active) => ipcRenderer.invoke(IPC.windowExamMode, { active }),
  onSession: (cb) => subscribe(IPC.evSession, cb),
  onAttempt: (cb) => subscribe(IPC.evAttempt, cb),
  onNetwork: (cb) => subscribe(IPC.evNetwork, cb),
  onQueue: (cb) => subscribe(IPC.evQueue, cb),
  onSecureMode: (cb) => subscribe(IPC.evSecureMode, cb),
  onDisplayChange: (cb) => subscribe(IPC.evDisplayChange, cb),
};

contextBridge.exposeInMainWorld('examguard', bridge);
