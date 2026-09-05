/**
 * ExamGuard shared domain types.
 * Wire-format enums are mirrored by Prisma enums in packages/database (DB is canonical);
 * these types are the source of truth for API DTOs and client code.
 */

// ---------------------------------------------------------------------------
// Roles & RBAC
// ---------------------------------------------------------------------------

export type RoleName =
  | 'SUPER_ADMIN'
  | 'ORG_ADMIN'
  | 'EXAM_MANAGER'
  | 'MONITOR'
  | 'STUDENT';

export const ROLE_NAMES: RoleName[] = [
  'SUPER_ADMIN',
  'ORG_ADMIN',
  'EXAM_MANAGER',
  'MONITOR',
  'STUDENT',
];

// ---------------------------------------------------------------------------
// Exams
// ---------------------------------------------------------------------------

export type ExamStatus = 'DRAFT' | 'SCHEDULED' | 'OPEN' | 'CLOSED';

export type QuestionType =
  | 'SINGLE_CHOICE'
  | 'MULTIPLE_CHOICE'
  | 'TRUE_FALSE'
  | 'SHORT_ANSWER'
  | 'LONG_ANSWER'
  | 'NUMERIC'
  | 'CODE';

export const AUTO_GRADABLE_QUESTION_TYPES: QuestionType[] = [
  'SINGLE_CHOICE',
  'MULTIPLE_CHOICE',
  'TRUE_FALSE',
  'NUMERIC',
];

export type Difficulty = 'EASY' | 'MEDIUM' | 'HARD';

export type ClipboardPolicy = 'ALLOW' | 'BLOCK' | 'NOTIFY';
export type FullScreenPolicy = 'REQUIRED' | 'RECOMMENDED' | 'NOT_REQUIRED';
export type AppSwitchPolicy = 'BLOCK' | 'DETECT' | 'ALLOW';
export type MultipleFacePolicy = 'ALERT' | 'BLOCK' | 'ALLOW';
export type EvidencePolicy = 'NONE' | 'EVENT_ONLY' | 'FULL_RECORDING';

// ---------------------------------------------------------------------------
// Attempts
// ---------------------------------------------------------------------------

export type AttemptStatus =
  | 'CREATED'
  | 'READY'
  | 'ACTIVE'
  | 'PAUSED'
  | 'SUBMITTED'
  | 'AUTO_SUBMITTED'
  | 'TERMINATED'
  | 'DISCONNECTED'
  | 'UNDER_REVIEW';

export const ACTIVE_ATTEMPT_STATUSES: AttemptStatus[] = ['ACTIVE', 'PAUSED', 'DISCONNECTED'];

// ---------------------------------------------------------------------------
// Proctoring
// ---------------------------------------------------------------------------

export type ProctoringEventType =
  | 'FACE_DETECTED'
  | 'FACE_MISSING'
  | 'MULTIPLE_FACES'
  | 'FACE_PARTIALLY_VISIBLE'
  | 'CAMERA_BLOCKED'
  | 'CAMERA_CONNECTED'
  | 'CAMERA_DISCONNECTED'
  | 'CAMERA_PERMISSION_GRANTED'
  | 'CAMERA_PERMISSION_DENIED'
  | 'CAMERA_PERMISSION_REVOKED'
  | 'CAMERA_DEVICE_CHANGED'
  | 'MIC_CONNECTED'
  | 'MIC_DISCONNECTED'
  | 'MIC_MUTED'
  | 'MIC_UNMUTED'
  | 'MIC_PERMISSION_GRANTED'
  | 'MIC_PERMISSION_DENIED'
  | 'MIC_PERMISSION_REVOKED'
  | 'AUDIO_LEVEL'
  | 'SCREEN_CAPTURE_STARTED'
  | 'SCREEN_CAPTURE_STOPPED'
  | 'SCREEN_PERMISSION_GRANTED'
  | 'SCREEN_PERMISSION_DENIED'
  | 'SCREEN_PERMISSION_REVOKED'
  | 'DISPLAY_CHANGED'
  | 'MULTIPLE_DISPLAY_DETECTED'
  | 'EXAM_WINDOW_LOST_FOCUS'
  | 'EXAM_WINDOW_FOCUS_RESTORED'
  | 'NETWORK_LOST'
  | 'NETWORK_RESTORED'
  | 'MEDIA_SESSION_CREATED'
  | 'MEDIA_CONNECTED'
  | 'MEDIA_DISCONNECTED'
  | 'MEDIA_RECONNECTING'
  | 'MEDIA_RECONNECTED'
  | 'MEDIA_FAILED'
  | 'MEDIA_PUBLISHER_CONNECTING'
  | 'MEDIA_PUBLISHER_CONNECTED'
  | 'MEDIA_PUBLISHER_RECONNECTING'
  | 'MEDIA_PUBLISHER_RECONNECTED'
  | 'MEDIA_PUBLISHER_DISCONNECTED'
  | 'MEDIA_PUBLISHER_FAILED'
  | 'TRACK_PUBLISHED'
  | 'TRACK_UNPUBLISHED';

export type AiEventType =
  | 'FACE_MISSING'
  | 'MULTIPLE_FACES'
  | 'PHONE_DETECTED'
  | 'BOOK_DETECTED'
  | 'PAPER_DETECTED'
  | 'SECOND_PERSON'
  | 'CAMERA_BLOCKED'
  | 'LOOKING_AWAY'
  | 'UNAUTHORIZED_OBJECT'
  | 'ENVIRONMENT_CHANGE'
  | 'FACE_PARTIALLY_VISIBLE';

export type Severity = 'INFO' | 'WARNING' | 'CRITICAL';

export type RiskLevel = 'NORMAL' | 'LOW_CONCERN' | 'SUSPICIOUS' | 'CRITICAL';

export type AiEventStatus = 'PENDING' | 'DISMISSED' | 'CONFIRMED' | 'FLAGGED';

export type MonitorActionType =
  | 'PAUSE'
  | 'RESUME'
  | 'TERMINATE'
  | 'MESSAGE'
  | 'FLAG'
  | 'NOTE';

export type MediaSessionStatus =
  | 'CONNECTING'
  | 'ACTIVE'
  | 'PAUSED'
  | 'ENDED'
  | 'FAILED';

export type MediaParticipantStatus =
  | 'CONNECTING'
  | 'ACTIVE'
  | 'RECONNECTING'
  | 'DISCONNECTED'
  | 'ENDED'
  | 'FAILED';

export type DeviceSessionStatus = 'ACTIVE' | 'DISCONNECTED' | 'ENDED';

// ---------------------------------------------------------------------------
// Media session control plane (Phase 4A) — REST + gateway contract
// ---------------------------------------------------------------------------

/** REST metadata for an attempt's publisher media session/participant. */
export interface MediaSessionDTO {
  /** Media-session id == logical participant id (one participant per session). */
  id: string;
  participantId: string;
  attemptId: string;
  examId: string;
  studentId: string;
  organizationId: string;
  /** Gateway/presence state: CONNECTING | ACTIVE | RECONNECTING | DISCONNECTED | ENDED | FAILED */
  state: MediaParticipantStatus;
  connectedAt: string | null;
  lastSeenAt: string | null;
  endedAt: string | null;
  createdAt: string;
}

/** Monitor-facing discovery item (metadata only — never media/credentials). */
export interface MediaSessionListItem {
  studentId: string;
  studentCode: string;
  studentName: string;
  attemptId: string;
  mediaSessionId: string;
  participantId: string;
  state: MediaParticipantStatus;
  connectedAt: string | null;
  lastSeenAt: string | null;
  endedAt: string | null;
}

/** Short-lived SFU publisher credential + endpoint (Phase 4B). */
export interface MediaTokenDTO {
  token: string;
  sfuUrl: string;
  mediaSessionId: string;
  participantId: string;
  attemptId: string;
  expiresInSeconds: number;
}

// ---------------------------------------------------------------------------
// Recordings (Phase 5) — evidence metadata contract. Never carries media
// payloads: objects live in storage; these types are the API wire contract.
// ---------------------------------------------------------------------------

export type RecordingStatus =
  | 'PENDING'
  | 'RECORDING'
  | 'FINALIZING'
  | 'READY'
  | 'FAILED'
  | 'DELETED';

export type RecordingKind = 'CAMERA' | 'MICROPHONE' | 'SCREEN' | 'COMBINED';

/** Recording metadata (never media payloads). */
export interface RecordingDTO {
  id: string;
  organizationId: string;
  examId: string;
  attemptId: string;
  participantId: string | null;
  kind: RecordingKind;
  status: RecordingStatus;
  /** Server-generated, tenant-scoped object key (never client-supplied). */
  storageKey: string;
  sizeBytes: number | null;
  durationMs: number | null;
  checksumSha256: string | null;
  startedAt: string | null;
  endedAt: string | null;
  failureReason: string | null;
  retentionUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Realtime event vocabulary (spec §34) — transport-agnostic contract
// ---------------------------------------------------------------------------

export interface RealtimeEvent<T = unknown> {
  event: string;
  payload: T;
  emittedAt: string; // ISO
  attemptId?: string;
  examId?: string;
  organizationId?: string;
}

export type RealtimeEventName =
  | 'student.connected'
  | 'student.disconnected'
  | 'student.camera.connected'
  | 'student.camera.disconnected'
  | 'student.mic.connected'
  | 'student.screen.connected'
  | 'student.screen.disconnected'
  | 'student.focus.lost'
  | 'student.focus.restored'
  | 'student.paused'
  | 'student.resumed'
  | 'student.terminated'
  | 'student.submitted'
  | 'ai.alert'
  | 'monitor.action'
  | 'exam.timer';

export interface StudentPausedPayload {
  attemptId: string;
  reason: string;
  durationSeconds: number;
  remainingMs: number;
}

export interface AiAlertPayload {
  attemptId: string;
  eventType: AiEventType;
  confidence: number;
  riskScore: number;
  riskLevel: RiskLevel;
}

export interface MonitorActionPayload {
  attemptId: string;
  action: MonitorActionType;
  monitorId: string;
  reason?: string;
}

// ---------------------------------------------------------------------------
// API DTOs
// ---------------------------------------------------------------------------

export interface UserDTO {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  isActive: boolean;
  role: RoleName;
  createdAt: string;
}

export interface OrganizationDTO {
  id: string;
  name: string;
  slug: string;
  plan: string;
  status: string;
  createdAt: string;
}

export interface QuestionOptionDTO {
  id: string;
  text: string;
  order: number;
}

export interface QuestionDTO {
  id: string;
  type: QuestionType;
  text: string;
  marks: number;
  negativeMarks: number;
  difficulty: Difficulty;
  options: QuestionOptionDTO[];
  metadata?: Record<string, unknown> | null;
}

export interface ExamDTO {
  id: string;
  name: string;
  description: string | null;
  instructions: string | null;
  startAt: string | null;
  endAt: string | null;
  durationMinutes: number;
  maxAttempts: number;
  shuffleQuestions: boolean;
  shuffleOptions: boolean;
  negativeMarkingEnabled: boolean;
  negativeMarkingValue: number;
  passingScore: number;
  autoSubmit: boolean;
  status: ExamStatus;
  questionCount?: number;
  assignedStudents?: number;
}

export interface ExamSettingsDTO {
  cameraRequired: boolean;
  microphoneRequired: boolean;
  screenMonitoringRequired: boolean;
  identityVerificationRequired: boolean;
  aiProctoringEnabled: boolean;
  clipboardPolicy: ClipboardPolicy;
  fullScreenPolicy: FullScreenPolicy;
  appSwitchPolicy: AppSwitchPolicy;
  multipleFacePolicy: MultipleFacePolicy;
  phoneObjectDetection: boolean;
  allowOfflineMode: boolean;
  evidencePolicy: EvidencePolicy;
  retentionDays: number;
}

export interface AttemptDTO {
  id: string;
  examId: string;
  examName: string;
  status: AttemptStatus;
  startedAt: string | null;
  submittedAt: string | null;
  deadline: string | null; // server-authoritative
  remainingMs: number;
  paused: boolean;
  questionCount: number;
  answeredCount: number;
  score: number | null;
}

export interface MonitorStudentDTO {
  attemptId: string | null;
  studentId: string;
  studentName: string;
  status: AttemptStatus | 'NOT_STARTED';
  riskScore: number;
  riskLevel: RiskLevel;
  cameraConnected: boolean;
  micConnected: boolean;
  screenConnected: boolean;
  lastSignalAt: string | null;
  assignmentId: string;
}

export interface PauseRequest {
  durationSeconds: number;
  reason: string;
}

export interface MonitorActionDTO {
  id: string;
  action: MonitorActionType;
  reason: string | null;
  payload: Record<string, unknown> | null;
  monitorName: string;
  createdAt: string;
}

export interface AuditLogDTO {
  id: string;
  actorEmail: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  detail: Record<string, unknown> | null;
  ip: string | null;
  createdAt: string;
}