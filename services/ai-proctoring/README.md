# @examguard/ai-proctoring (Phase 5 — NOT YET IMPLEMENTED)

**Status:** Designed. Placeholder contract — see `docs/AI-PROCTORING.md`.

- Python service (ONNX Runtime + MediaPipe/YOLO) consuming sampled frames from the SFU.
- Emits `AiEvent` rows through `POST /api/v1/ai/events` (contract **implemented and tested** in `services/api`), including `confidence`, `modelVersion`, `evidenceRef`.
- The risk engine (`packages/security/src/risk.ts`, unit-tested, configurable weights per exam) consumes those events.
- Assistive only: no auto-verdicts; human monitors review via the monitor console.