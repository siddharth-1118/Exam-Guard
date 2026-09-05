# ExamGuard — Mobile Monitor Application (Phase 6 — designed, not built)

> **Status:** Phase 6. `apps/monitor-mobile` is a placeholder containing this contract.

## 1. Purpose

Monitor application for **Android and iOS** focused on rapid triage (spec §11). It mirrors `apps/monitor-web` but is designed for interruption-driven use: alert → tap → assess → act.

## 2. Tech

React Native (Expo) with native modules only where required (push notifications via FCM/APNs, background WebRTC keep-alive limits respected). WebRTC via `react-native-webrtc` (SFU subscription). Camera/screen viewing is stream subscription, not device capture.

## 3. Triage-First UI (spec §11)

```
ExamGuard Monitor                     09:41
Java Programming — Exam 3
┌─────────────────────────────┐
│  🔴 CRITICAL      5         │
│  🟡 SUSPICIOUS   13         │
│  🟢 NORMAL       82         │
└─────────────────────────────┘
[Student 47] [Student 71] [Student 31]
  🔴 PHONE       🔴 2 FACES     🟡 FACE
```
- Top summary counts (live via realtime events).
- Sorted list: critical first, then suspicious, then normal.
- Tap student → detail screen (identity, camera tile, screen tile, audio level, event timeline, action bar).

## 4. Actions

`PAUSE` (with duration + required reason) · `RESUME` · `TERMINATE` (double-confirm) · `MESSAGE` (predefined + custom) · `FLAG` · `ADD NOTE`. All go through the same `/api/v1/monitoring/*` endpoints as the web dashboard; the **server** enforces everything (§14–§16).

## 5. Platform Honesty

- Push notifications: best-effort (OS throttling documented). Critical alerts fall back to the web dashboard for guaranteed delivery.
- WebRTC on mobile: adaptive quality; cellular networks are expected to yield low-bitrate thumbnails.
- iOS/Android cannot observe other apps or enforce lockdown — the mobile app is strictly a *monitor*; it will never be marketed as a student lockdown device (spec §10 matrix: NO for lockdown).