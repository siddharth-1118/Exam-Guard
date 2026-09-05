# ExamGuard Security & Integrity Architecture (Phase 11)

This document describes the security controls, context-isolated Electron architecture, authentication security, and platform boundary limits for ExamGuard.

---

## 1. Electron Security Configuration

ExamGuard Student Desktop enforces strict web security and renderer isolation guidelines:

| Property | Value | Security Effect |
| :--- | :---: | :--- |
| `contextIsolation` | `true` | Prevents renderer scripts from accessing Electron internal prototypes. |
| `sandbox` | `true` | Runs renderer process inside OS-level Chromium sandbox without Node.js bindings. |
| `nodeIntegration` | `false` | Disables Node.js `require()` and `process` access inside browser windows. |
| `webSecurity` | `true` | Enforces same-origin policy, CORS, and strict web security rules. |
| `allowRunningInsecureContent` | `false` | Blocks mixed HTTP content loading inside secure HTTPS renderer. |

---

## 2. Desktop Shortcut & Navigation Interception

The main Electron process (`apps/student-desktop/electron/main.ts`) intercepts input events and blocks unauthorized navigation:

- **Shortcut Key Interception**: Intercepts `F12`, `F5`, `Ctrl+Shift+I/C/J`, `Ctrl+U`, `Ctrl+R`, `Cmd+Alt+I`, `Cmd+R`.
- **Navigation Lockdown**: Cancels `window.open()`, external URL navigations, and unauthorized redirects.
- **Window Focus Monitoring**: Listens to window `blur` events; generates security focus-loss alerts sent directly to proctors.
- **Display Topology Monitoring**: Detects multi-display connection/disconnection events during exam sessions.

---

## 3. Honest Platform Lockdown Boundaries

> [!CAUTION]
> **Application-Level vs OS-Level Lockdown Boundary**:
> ExamGuard provides strong **application-level lockdown** within user-space Electron environment. However, without dedicated OS kernel drivers or Enterprise Kiosk Policy MDM management:
> - Hardware power buttons, physical reset switches, and OS hard reboots cannot be intercepted by user-space apps.
> - Low-level OS shortcuts such as Windows `Ctrl+Alt+Del`, `Win+L` lock screen, or macOS system overlay shortcuts cannot be blocked from standard un-elevated user accounts.
> - External hardware video capture cards (HDMI splitters/capture cards) operating outside OS software layer cannot be detected via software API.

---

## 4. Multi-Tenancy & Authentication Security

- **JWT Tokens**: Access tokens (15m TTL), Refresh tokens (7d TTL), Token versioning for instant session revocation.
- **Argon2id Hashing**: Password storage using Argon2id.
- **Rate Limiting**: Login rate limiting (10 req/min per IP) via NestJS `CustomThrottlerGuard`.
- **RBAC Enforcement**: Strict role authorization (`SUPER_ADMIN`, `ORG_ADMIN`, `EXAM_MANAGER`, `MONITOR`, `STUDENT`) with tenant scoping (`organizationId`).
