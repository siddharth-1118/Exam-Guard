/**
 * Desktop ↔ main-process ↔ backend contracts.
 * This file is shared between the sandboxed renderer (via preload typings),
 * the main process, and unit tests. It must not import Electron or Node APIs.
 */

import type { ProctoringEventType, Severity } from '@examguard/types';

// ---------------------------------------------------------------------------
// App / environment
// ---------------------------------------------------------------------------

export interface AppInfo {
  appVersion: string;
  electronVersion: string;
  chromeVersion: string;
  platform: string; // process.platform — 'win32' | 'darwin' | 'linux' | ...
  arch: string;
  osRelease: string;
  userDataPath: string;
  displayCount: number;
  lockDown: { fullscreen: boolean; devTools: boolean };
}

export interface ExamSettingsLike {
  cameraRequired: boolean;
  microphoneRequired: boolean;
  screenMonitoringRequired: boolean;
  clipboardPolicy: string;
  fullScreenPolicy: string;
  appSwitchPolicy: string;
  allowOfflineMode: boolean;
  [key: string]: unknown;
}

export interface AssignedExam {
  id: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  status: string;
  startAt: string | null;
  endAt: string | null;
  settings?: ExamSettingsLike | null;
}

export interface UserProfile {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  organizationId: string | null;
}

// ---------------------------------------------------------------------------
// Sensor events (the vocabulary the desktop reports into the backend pipeline)
// ---------------------------------------------------------------------------

export type SensorKind = 'camera' | 'microphone' | 'screen' | 'system';

export interface SensorEventPayload {
  /** Backend event type — validated against the server catalog. */
  type: ProctoringEventType;
  severity?: Severity;
  detail?: Record<string, unknown>;
}

export interface QueuedEvent extends SensorEventPayload {
  /** Client-generated idempotency key; stable across network retries. */
  clientEventId: string;
  createdAt: string;
}

export interface MediaSessionUpdate {
  kind: 'CAMERA' | 'MICROPHONE' | 'SCREEN';
  status: 'CONNECTING' | 'ACTIVE' | 'PAUSED' | 'ENDED' | 'FAILED';
  muted?: boolean;
  audioLevel?: number;
}

/** A capture source offered by the OS (desktopCapturer): one per display. */
export interface ScreenSourceInfo {
  id: string;
  name: string;
  type: 'screen' | 'window';
  displayId?: string;
}

// ---------------------------------------------------------------------------
// Media-session control plane (Phase 4A) — REST metadata from the API
// ---------------------------------------------------------------------------

export interface MediaSessionInfo {
  id: string;
  participantId: string;
  attemptId: string;
  examId: string;
  state: 'CONNECTING' | 'ACTIVE' | 'RECONNECTING' | 'DISCONNECTED' | 'ENDED' | 'FAILED';
  connectedAt: string | null;
  lastSeenAt: string | null;
  endedAt: string | null;
  createdAt: string;
}

/** Short-lived SFU publisher credential handed to the renderer publisher. */
export interface MediaTokenInfo {
  token: string;
  sfuUrl: string;
  mediaSessionId: string;
  participantId: string;
  attemptId: string;
  expiresInSeconds: number;
}

// ---------------------------------------------------------------------------
// Attempt state pushed to the renderer (server-authoritative)
// ---------------------------------------------------------------------------

export interface AttemptView {
  id: string;
  examId: string;
  examName: string;
  status: string;
  startedAt: string | null;
  submittedAt: string | null;
  deadline: string | null;
  remainingMs: number;
  paused: boolean;
  questionCount: number;
  answeredCount: number;
  score: number | null;
}

export type RendererStatus =
  | 'idle'
  | 'starting'
  | 'active'
  | 'paused'
  | 'submitted'
  | 'terminated'
  | 'expired'
  | 'error';

export interface RendererAttemptState {
  status: RendererStatus;
  attempt: AttemptView | null;
  pausedReason?: string;
  blocked: boolean;
}

// ---------------------------------------------------------------------------
// IPC contract (channel names + payloads)
// ---------------------------------------------------------------------------

export const IPC = {
  appInfo: 'app:info',
  authLogin: 'auth:login',
  authLogout: 'auth:logout',
  authStatus: 'auth:status',
  examsList: 'exams:list',
  examGet: 'exam:get',
  attemptStart: 'attempt:start',
  attemptGet: 'attempt:get',
  answerSave: 'answers:save',
  attemptHeartbeat: 'attempt:heartbeat',
  attemptSubmit: 'attempt:submit',
  sensorReport: 'sensors:report',
  mediaSession: 'media:session',
  mediaToken: 'media:token',
  screenSources: 'screen:sources',
  windowExamMode: 'window:exam-mode',
  // main → renderer events
  evSession: 'ev:session',
  evAttempt: 'ev:attempt',
  evNetwork: 'ev:network',
  evQueue: 'ev:queue',
  evSecureMode: 'ev:secure-mode',
  evDisplayChange: 'ev:display-change',
} as const;

/** The API surface preload exposes to the renderer (typed window.examguard). */
export interface DesktopBridge {
  getAppInfo(): Promise<AppInfo>;
  login(email: string, password: string): Promise<{ user: UserProfile }>;
  logout(): Promise<void>;
  authStatus(): Promise<{ loggedIn: boolean; user: UserProfile | null }>;
  listExams(): Promise<AssignedExam[]>;
  getExam(id: string): Promise<AssignedExam>;
  startAttempt(
    examId: string,
    opts: { consent: Record<string, unknown>; deviceInfo: Record<string, unknown> },
  ): Promise<{ attempt: AttemptView; questions: unknown[] }>;
  getAttempt(id: string): Promise<{ attempt: AttemptView; questions: unknown[]; answers: Array<{ questionId: string; value: unknown }> }>;
  saveAnswer(attemptId: string, questionId: string, value: unknown): Promise<{ remainingMs: number }>;
  heartbeat(attemptId: string): Promise<AttemptView>;
  submit(attemptId: string): Promise<AttemptView>;
  reportSensor(payload: SensorEventPayload): Promise<{ queued: boolean }>;
  updateMediaSession(update: MediaSessionUpdate): Promise<void>;
  getMediaToken(attemptId: string): Promise<MediaTokenInfo>;
  listScreenSources(): Promise<ScreenSourceInfo[]>;
  setExamMode(active: boolean): Promise<{ fullscreen: boolean }>;
  onSession(cb: (user: UserProfile | null) => void): () => void;
  onAttempt(cb: (state: RendererAttemptState) => void): () => void;
  onNetwork(cb: (online: boolean) => void): () => void;
  onQueue(cb: (status: { pending: number; online: boolean }) => void): () => void;
  onSecureMode(cb: (active: boolean) => void): () => void;
  onDisplayChange(cb: () => void): () => void;
}
