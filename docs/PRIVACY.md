# ExamGuard — Privacy

## 1. Principles (spec §26)

1. **Never hide monitoring.** The student UI displays live indicators (camera, microphone, screen) plus a link to this notice before and during the exam. Monitoring starts only after explicit consent in the pre-exam flow (§8).
2. **Collect the minimum.** Device info is technical (OS, app version, screen config, connection info — spec §43), never personal beyond identity necessary for the exam.
3. **Retention is bounded and configurable** per exam/org (`retention_days`, default 90; `evidence_policy` default `EVENT_ONLY`).
4. **Deletion is possible** — org admins can execute data-deletion flows; every deletion is audit-logged.
5. **Access is role-scoped and audited** — private recordings require explicit authorization (super admin can't casually browse; `audit_logs` record every access).

## 2. Data Inventory

| Data | Collected | Retention | Access |
|---|---|---|---|
| Identity (name, email, student id) | Yes | Org lifecycle | Org admin, exam staff |
| Answers | Yes | Per org policy | Exam staff; student (post-release) |
| Camera/audio/screen (recordings or event evidence) | Per exam policy only | `retention_days` | Monitor, org admin; all access audited |
| AI events & risk scores | Yes (if AI enabled) | `retention_days` | Monitor, org admin |
| Device/session telemetry | Yes (technical) | 30d rolling | Org admin, security dashboard |
| Audit logs | Yes | 1 year (configurable) | `audit:read` holders |
| Raw network/metadata | No | — | — |

## 3. Consent Flow

Pre-exam screen lists exactly what is monitored for this exam (from `exam_settings`): camera required, mic required, screen required, AI proctoring, recording policy. Consent checkbox is required to proceed. Consent + version of notice are stored with the attempt (`exam_attempts.consent` JSONB) so there is a record of what the student agreed to.

## 4. Student Rights

- **View:** student can see their own attempts, answers, and proctoring summary for their exams (post-release).
- **Export:** org admins can export a student's data (report generation).
- **Deletion:** org admins can run deletion per student or per exam; `audit_logs` records actor/time/scope; object-storage deletion is async with confirmation.

## 5. Technical Controls

- Encryption at rest (object storage SSE, DB volume encryption) and in transit (TLS).
- Signed, short-lived, scoped URLs for evidence access; no public buckets.
- Access control on all PII-bearing endpoints via RBAC + organization scoping (never just frontend filtering).
- Security dashboard (§42) surfaces anomalous access patterns.

## 6. What We Will Not Do

- No hidden/undisclosed recording. Recording indicators are always visible and exam policies define recording up front.
- No selling or sharing of student data; no ad tech.
- No speech-content analysis without explicit opt-in consent by the org and students (audio is level-monitoring only by default).