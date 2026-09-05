# ExamGuard — Platform Security Capability Matrix

Last updated 2026-09-04. This matrix states **what is actually implemented and verifiable**
today, per platform. "YES" is only used where the mechanism exists and is enforced.
Anything marked PLANNED is on the roadmap (`docs/ROADMAP.md`) but has no implementation yet.

## Delivery clients and their real capabilities today

| Capability | Web (admin/monitor/student portals) | Desktop app (Windows/macOS/Linux) | Mobile monitor (Android/iOS) |
|---|---|---|---|
| Client exists | ✅ implemented | ❌ README placeholder (`apps/student-desktop/`) | ❌ README placeholder (`apps/monitor-mobile/`) |
| Auth + exam taking | ✅ (student web runner: server timer, autosave, submit) | — | — |
| OS-level lockdown (Alt+Tab, Win key, Cmd+Tab) | ❌ **impossible in a browser** — compensated by detection-only events | — | — |
| Clipboard restriction | ❌ impossible in browser | — | — |
| Fullscreen | ⚠️ browser Fullscreen API only (requestable, not enforceable) | — | — |
| Camera / mic / screen capture for proctoring | ❌ none (API contract exists) | — | — |
| WebRTC monitor streams | ❌ none (`services/media` placeholder) | — | — |

## Target desktop matrix (planned — NOT yet implemented)

Planned architecture per `docs/DESKTOP.md` and `docs/ARCHITECTURE.md`. Status column is the
*design intent*, not reality. Re-verify against the real client once Phase 3 lands.

| Capability | Windows | macOS | Linux | Notes / intended mechanism |
|---|---|---|---|---|
| Secure fullscreen / exam-surface focus | Planned | Planned | Planned | Native kiosk + window-manager hooks; browser fullscreen is NOT sufficient |
| Application / shortcut lockdown | Planned (Win32 hooks, Group Policy) | Planned (CGEventTap; accessibility permission) | Planned (limited to supported DEs: GNOME/KDE X11; Wayland constraints) | macOS/Linux partially supportable — document per-DE |
| Clipboard restriction | Planned | Planned (limited) | Planned (limited) | X11 intercept; Wayland sandbox constraints |
| Process detection | Planned (EnumWindows/ETW) | Planned (NSWorkspace/ps) | Limited (procfs) | — |
| Display / external-monitor detection | Planned | Planned | Planned (X11; Wayland limited) | — |
| Camera / microphone | Planned (Media Foundation) | Planned (AVFoundation) | Planned (V4L2/PipeWire) | — |
| Screen capture | Planned | Planned | Planned (PipeWire portal; X11) | — |
| Remote desktop / VM detection | Planned (partial) | Planned (partial) | Planned (partial) | Detection only — never claim prevention |
| Min supported versions (design intent) | Windows 10 22H2+ | macOS 12+ | Ubuntu 22.04 LTS (GNOME X11) — define a support list, not "all Linux" | See `docs/DESKTOP.md` |

## Honest statements that must never appear in marketing/docs

- ❌ "JavaScript prevents Alt+Tab" — false; browsers cannot do this.
- ❌ "Fullscreen means the computer is locked" — false; Fullscreen API is request-only and
  escapeable.
- ❌ "AI detects cheating" — the system produces *suspicion/risk*, human review decides
  (spec §21–24); no auto-fail path exists in code.
- ❌ "Web delivery is a locked-down exam environment" — web is the convenience/fallback
  path; it cannot enforce OS restrictions. Detectable client events for web are limited to
  focus/blur and network state.

## Platform-verification status

Only the **web** platform is implemented and was tested during this audit (three Next.js
portals; e2e + live probes pass). All rows above the "Target desktop matrix" heading that
say Planned apply to software that does not yet exist, and must not be reported as
capabilities until `apps/student-desktop` is built and verified on each OS.
