# ExamGuard Live Proctoring & System Monitoring (Phase 9 & 10)

This document describes both the real-time proctor monitoring console architecture (Student ↔ SFU ↔ Monitor connection) and system health metrics.

---

## 1. Student ↔ Monitor Streaming Architecture

```
Student Desktop Client
  │ (WebRTC Multi-Stream RTP)
  ├── Webcam Stream Producer
  ├── Microphone Stream Producer
  └── Screen Share Stream Producer
        │
        v
  Mediasoup SFU Server Daemon (Port 4010)
        │
        v (WebRTC Consumer RTP)
  Proctor Monitor Web Console (apps/monitor-web)
        │
        ├── Real-time Candidate Video Grid
        ├── Focus & Active Screen View
        ├── Live Audio Level Indicator
        ├── Security Risk Score (0-100)
        └── Real-time AI Proctoring Event Stream
```

---

## 2. Proctor Control Actions & Pause Durations

Authorized proctors monitoring an active exam session can execute server-authoritative control actions:

| Action | Endpoint | Audit Action | Server Behavior |
| :--- | :--- | :--- | :--- |
| **Pause Exam** | `POST /api/v1/monitoring/students/:id/pause` | `attempt.paused` | Sets `pausedAt = new Date()`. Student exam timer freezes; answer submissions are rejected with `HTTP 400: Attempt is paused`. |
| **Resume Exam** | `POST /api/v1/monitoring/students/:id/resume` | `attempt.resumed` | Folds paused duration into `accumulatedPausedSeconds`. Student exam unfreezes; attempt returns to `ACTIVE`. |
| **Terminate Exam** | `POST /api/v1/monitoring/students/:id/terminate` | `attempt.terminated` | Sets status to `TERMINATED`. Disconnects media streams and locks candidate from further attempt activity. |
| **Send Message** | `POST /api/v1/monitoring/students/:id/message` | `proctor.message` | Sends high-priority text notification modal directly to candidate desktop screen via WebSocket. |
| **Flag Incident** | `POST /api/v1/monitoring/students/:id/flag` | `proctor.flag` | Attaches security flag and advisory note to candidate attempt record for post-exam review. |

### Supported Pause Durations
- **30 seconds** (Brief identity verification pause)
- **1 minute** (Environment check pause)
- **5 minutes** (Network recovery pause)
- **10 minutes** (Formal proctor review pause)
- **Custom duration** (Specified by proctor in minutes)

---

## 3. Metrics Endpoint & Prometheus Monitoring

ExamGuard exposes Prometheus-compatible metrics at `GET /metrics`.

| Metric | Type | Description |
| :--- | :--- | :--- |
| `examguard_http_requests_total` | counter | Total HTTP requests by method, route, status |
| `examguard_http_request_duration_seconds` | histogram | Request latency distribution |
| `examguard_attempts_active` | gauge | Currently active exam attempts |
| `examguard_media_participants` | gauge | Active media participants connected to SFU |
| `examguard_recordings_active` | gauge | Active recording sessions |
| `examguard_redis_health` | gauge | Redis connectivity (1=healthy, 0=unhealthy) |
| `examguard_auth_failures_total` | counter | Failed authentication attempts |
| `examguard_mfa_failures_total` | counter | Failed MFA verification attempts |
