# ExamGuard — Student Desktop Application (Phase 3 — designed, not built)

> **Status:** Phase 3. This document is the authoritative design. No desktop code exists yet in this repository; `apps/student-desktop` is a placeholder containing this contract. Nothing below is claimed as implemented.

## 1. Why a Desktop App Exists

A browser cannot enforce OS-level restrictions (Alt+Tab, application switching, clipboard, screen capture conflicts, system shortcuts). The desktop app is the **primary student surface**; `apps/student-web` exists as a fallback/dry-run surface with **documented, weaker guarantees** (web delivery is offered only when the exam policy permits it).

## 2. Platform & Runtime

- **Shell:** Electron (Chromium) — fastest path to a native-feeling exam UI with WebRTC, camera/mic/screen capture, and a Node main process for OS-level work. Native Node modules (or OS APIs via a thin Rust/Go sidecar where Electron cannot) handle lockdown.
- **Isolation:** renderer (exam UI) runs sandboxed with `contextIsolation: true`, no Node in renderer; all privileged operations live in the main process behind a narrow IPC API.
- **Update channel:** signed updates (code-signing per OS), version manifest fetched from backend; backend enforces `minVersion` / `recommendedVersion` / `blockedVersions` per exam (spec §45). Outdated/blocked clients refuse to launch exams.
- **Integrity:** app binaries are code-signed; the updater verifies signatures; basic tamper detection (bundle hash check) and a documented list of what integrity checks do **not** cover (a rooted/jailbroken machine is out of scope — documented).

## 3. Module Layout (spec §10)

```
apps/student-desktop/
  core/            # auth, exam-session, realtime, monitoring, storage, security
  windows/         # lockdown, process-monitoring, display-monitoring, permissions
  macos/           # lockdown, permissions, display-monitoring, security
  linux/           # lockdown, session-management, display-monitoring, security
  ui/              # exam-interface
  native/          # (future) native helper for per-OS enforcement
```

OS-specific modules implement a common interface (`ILockdown`, `IProcessMonitor`, …) so capability differences are explicit, not hidden.

## 4. Capability Matrix (spec §10, honest)

| Feature | Windows | macOS | Linux¹ | Android | iOS |
|---|---|---|---|---|---|
| Secure fullscreen (kiosk-style) | **YES** — `SetWindowDisplayAffinity` + exclusive borderless fullscreen; focus is captured; alt-tab hook | **YES** — fullscreen Spaces + `NSApplication` activation policy; admin can always unlock (documented) | **PARTIAL** — depends on compositor (GNOME/KDE Wayland vs X11); focus-loss detection as compensating control | NO | NO |
| Clipboard control | **YES** — Win32 clipboard monitor/clear | **PARTIAL** — `NSPasteboard` clear/deny; third-party keyboards bypass | **PARTIAL** — X11 selection ownership; Wayland apps can ignore | NO | NO |
| External display detection | **YES** — `QueryDisplayConfig` | **YES** — `NSScreen` observation | **PARTIAL** — XRandR/Wayland output enumeration | NO | NO |
| Camera / Microphone | **YES** — WebRTC getUserMedia | **YES** — TCC permission required (documented UX) | **YES** | YES (app-scoped) | YES (app-scoped) |
| Screen capture | **YES** | **YES** — Screen Recording TCC | **YES** — PipeWire/X11 | PARTIAL — only in-app (system picker) | PARTIAL — only in-app (ReplayKit picker) |
| Process enumeration (detect helpers/copilot tools) | **YES** — `EnumProcesses` | **YES** — `proc_listpids` (limited visibility in sandbox) | **LIMITED** — /proc; varies by distro | NO | NO |
| OS-level app-switch lockdown | **YES** — keyboard hook + foreground lock | **PARTIAL** — `NSApplication` can hide others; Cmd+Tab needs Accessibility/AX | **LIMITED** — compositor-dependent | NO | NO |
| Remote-desktop detection | **YES** — session API | **PARTIAL** | **PARTIAL** | NO | NO |

¹ **Officially supported Linux targets (v1):** Ubuntu 22.04/24.04 LTS (X11 + GNOME Wayland), Fedora 40+ (GNOME Wayland), Debian 12 (X11). Others are best-effort and marked unsupported until validated. Capability columns assume the supported matrix; X11 vs Wayland is detected at runtime and the app degrades honestly.

**Compensating-control doctrine (spec §59):** where a cell is PARTIAL/NO, we add detection + alert + monitor action instead of pretending to prevent. Examples: focus-loss events, `SCREEN_PERMISSION_REVOKED`, `DISPLAY_CHANGED`, window enumeration alerts.

## 5. Student Exam Flow (spec §8)

```
Login → Exam selection → System compatibility check → Device permission check
→ Camera test → Mic test → Screen-capture test → Network test → Device security check
→ Identity verification → Instructions → Consent → Secure environment init
→ EXAM STARTS → live monitoring → submission → sync → confirmation
→ release camera/mic/screen → exit lockdown → return to desktop
```
Each pre-check reports pass/warn/fail against the exam's policy (e.g., camera required ⇒ camera test must pass to proceed).

## 6. Lockdown Behavior by Platform (design)

- **Windows:** exclusive fullscreen window on the active display; `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` where applicable; low-level keyboard hook blocking system shortcuts (Win, Alt+Tab, Ctrl+Alt+Del is handled by the OS — documented as unpreventable and *detected*); foreground-process watchdog; clipboard clear on sensitive entry.
- **macOS:** dedicated fullscreen space; `presentationOptions` kiosk; hide Dock/Menu bar; AX permission prompt for Cmd+Tab interception (documented, opt-in); Screen Recording + Camera + Microphone TCC flow.
- **Linux:** compositor-aware: kiosk window flags (GDK/GTK or Qt), keyboard grab where compositor allows (X11), Wayland `zwlr_layer_shell` kiosk on GNOME; otherwise focus-loss detection with alert.

## 7. Offline Resilience (spec §37)

Local encrypted store (OS keychain-backed key, AES-GCM) buffers answers; monotonic per-answer `updatedAt` counters enable conflict-free merge on reconnect; heartbeat every 15s; reconnect with backoff; the server decides what time counts. If `allowOfflineMode=false` and connectivity is lost beyond the grace window, the server marks the attempt `DISCONNECTED` and the monitor is alerted (no instant auto-fail).

## 8. Identity Verification (design)

Phase 3 ships "face present + voice consent" capture for the record; Phase 5 adds liveness (blink/pose variance) and face-match against a proctoring-time baseline. Never "identity verified = identity proven" — the monitor sees the capture and can flag.