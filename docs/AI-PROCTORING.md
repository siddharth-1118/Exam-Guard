# ExamGuard — AI Proctoring Pipeline (Phase 5 — designed, not built)

> **Status:** Phase 5. This is the authoritative design. `services/ai-proctoring` is a placeholder containing this contract; **no detection code exists yet**.

## 1. Position in the System

```
Student streams (WebRTC SFU) ──► frame/audio sampling ──► AI pipeline
                                                              │
                modules: face, head-pose, object (YOLO),      │  (every module emits)
                person, environment-change                    ▼
                                                    AiEvent { event_type, confidence, timestamp,
                                                             student_id, exam_id, evidence_ref }
                                                              │
                                                              ▼
                                                     Risk Engine (packages/security)
                                                              │
                                                              ▼
                                                    Monitor alert (realtime, Phase 4)
                                                              │
                                                              ▼
                                                    HUMAN REVIEW → action or dismissal
```

**The AI never declares cheating.** It emits events + confidence; the risk engine aggregates; a human decides (spec §21, §24, §70). `AiEvent.status` tracks the human verdict: `PENDING → DISMISSED | CONFIRMED | FLAGGED`.

## 2. Modules (spec §21)

| Module | Model approach | Outputs |
|---|---|---|
| Face detection | MediaPipe Face Detector (ONNX export) | `FACE_DETECTED`, `FACE_MISSING`, `MULTIPLE_FACES`, `FACE_PARTIALLY_VISIBLE` |
| Head pose / gaze | MediaPipe Face Mesh landmarks → pose regression | `LOOKING_AWAY`, `FACE_POSITION_*` |
| Phone / object detection | YOLOv8-n (ONNX) fine-tuned | `PHONE_DETECTED`, `BOOK_DETECTED`, `PAPER_DETECTED`, `SECOND_PERSON`, `UNAUTHORIZED_OBJECT`, `CAMERA_BLOCKED` |
| Person detection | YOLO person class | `SECOND_PERSON` (multi-person frame) |
| Environment change | Frame-diff + scene embedding | `ENVIRONMENT_CHANGE`, `CAMERA_BLOCKED` (static-frame heuristic) |
| Liveness (identity step) | Blink/pose-variance | signal for identity verification (assistive) |

Each module is a small class behind `IDetectionModule { detect(frame): DetectorResult[] }`, so modules can be enabled/disabled per exam policy (e.g., `phoneObjectDetection: true`). Model artifacts are versioned and pinned; `AiEvent` rows include the model version in `evidence_ref` metadata for auditability.

## 3. Event Taxonomy (spec §22)

`FACE_MISSING`, `MULTIPLE_FACES`, `PHONE_DETECTED`, `BOOK_DETECTED`, `PAPER_DETECTED`, `SECOND_PERSON`, `CAMERA_BLOCKED`, `LOOKING_AWAY`, `UNAUTHORIZED_OBJECT`, plus camera/stream health events from the client (`CAMERA_BLOCKED`, `CAMERA_PERMISSION_REVOKED`, … — spec §18).

## 4. Confidence & Aggregation

- Detection → `AiEvent(confidence)`. Confidence is model-calibrated (temperature-scaled), not raw logits.
- The **risk engine** (`packages/security/src/risk.ts`) accumulates a 0–100 score per attempt from configurable weights (stored per-exam via `exam_settings.riskWeights` JSONB, default below):

| Event | Weight |
|---|---|
| FACE_MISSING | +20 (decay: repeated events within 60s don't stack at full value) |
| MULTIPLE_FACES | +50 |
| PHONE_DETECTED | +70 |
| CAMERA_BLOCKED | +60 |
| Repeated focus loss | +15 |
| SECOND_PERSON | +70 |
| LOOKING_AWAY (sustained) | +10 |

| Score | Level |
|---|---|
| 0–29 | NORMAL |
| 30–59 | LOW_CONCERN |
| 60–79 | SUSPICIOUS |
| 80–100 | CRITICAL |

Score decays over time (configurable half-life) so transient noise doesn't compound into a false "critical." The score is *context for humans*, not proof (spec §23).

## 5. Human Review (spec §24)

Monitor actions on an event/attempt: `DISMISS`, `CONFIRM`, `FLAG`, `PAUSE`, `TERMINATE`, `ADD_NOTE` — each writes `monitor_actions` + `audit_logs`. Confirmed events can attach evidence; confirmed critical events raise `UNDER_REVIEW` on the attempt, gating result publication until an org admin resolves it.

## 6. Evidence (spec §25)

`evidence_policy` per exam: `EVENT_ONLY` (default) captures a camera/screen snapshot clip around flagged events only; `FULL_RECORDING` captures continuously when explicitly enabled. Retention via `retention_days` (default 90), enforced by a worker. Evidence lives in object storage with signed, scoped, audited access — never world-readable.

## 7. Privacy by Design (spec §26)

- Consent is explicit, in the student flow, before monitoring starts (§8).
- The student UI shows live indicators: camera, mic, screen, and a link to the exam's privacy notice.
- Students can request their data (export) and deletion per org policy; `PRIVACY.md` details the flow.
- AI events are stored with a `privacyMode` flag when the exam policy requires minimizing retention (e.g., only aggregated risk, no raw frames).

## 8. Performance & Scale

- Sampling: 2 fps camera / 0.5 fps screen (configurable) at 640×360; audio analysis is level-only in Phase 5 (speech content analysis is explicitly out of scope unless an org opts in with consent).
- One AI worker processes ~200 streams at 2 fps on a GPU instance (documented estimate); workers scale horizontally behind a queue; events are idempotent by `(attempt, seq)`.

## 9. Honest Limitations

- False positives are expected; that is why the risk engine has decay and humans review.
- A determined cheater with a second hidden device may evade detection; layered controls (lockdown + monitoring + human review) reduce risk but **no system guarantees honesty** — documented explicitly in exam instructions and org-facing docs.