# ExamGuard Server-Authoritative Exam Scheduling (Phase 7 & 8)

This document details the scheduling specifications, server-authoritative timing rules, and edge-case behavior models implemented in ExamGuard.

> [!IMPORTANT]
> The student's local desktop clock is NEVER trusted for exam state transitions, countdown timers, or entry authorization. All time checks rely exclusively on server timestamps returned by the API backend.

---

## 1. Exam Time Fields & Calculations

- `startAt`: ISO 8601 timestamp representing the earliest official moment an exam attempt can be created or launched.
- `endAt`: ISO 8601 timestamp representing the hard closing cutoff after which no new attempts may start.
- `durationMinutes`: Allocated active exam time.
- `accumulatedPausedSeconds`: Total time spent in `PAUSED` state by proctor intervention.
- **Server Deadline Formula**:
  $$\text{Deadline} = \text{startedAt} + (\text{durationMinutes} \times 60,000) + (\text{accumulatedPausedSeconds} \times 1,000)$$

---

## 2. Schedule Cases A–H Behavior Matrix

| Case | Scenario | Client State | Server Response / Action |
| :--- | :--- | :--- | :--- |
| **Case A** | Student opens ExamGuard 30 minutes early | Displays "WAITING FOR START" screen with scheduled timestamp | API rejects `/attempts` start calls with `HTTP 400: Exam has not started` |
| **Case B** | Student opens ExamGuard 5 seconds before start | Preflight hardware checks active; exam button locked | Polls `/exams/:id` or WebSocket for status transition |
| **Case C** | Clock reaches scheduled start time | Application polls server state, receives `READY`/`OPEN` | Client calls `/attempts` POST; server issues session authorization |
| **Case D** | Student attempts manual trigger / clock modification | Client manipulates system clock to future time | Server verifies system `new Date()` against DB `startAt` and rejects attempt |
| **Case E** | Student disconnects before exam starts | Client exits preflight screen cleanly | No attempt record is created in database |
| **Case F** | Student reconnects after scheduled start | Client checks active attempt record | Server restores existing active attempt or authorizes fresh start if within window |
| **Case G** | Student joins after `endAt` expiration | Client attempts start | API rejects request with `HTTP 400: Exam has ended` |
| **Case H** | Attempt reaches calculated server deadline | Timer expires | Background `RetentionSweeper` or active server heartbeat auto-submits attempt (`autoSubmitted: true`) |
