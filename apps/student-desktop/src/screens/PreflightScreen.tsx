import { useEffect, useMemo, useState } from 'react';
import { bridge } from '../lib/bridge';
import { getAvailableCameras, preflightDevice, preflightScreenSource, probeAvailability } from '../media/devices';
import type { AssignedExam, ExamSettingsLike } from '../shared/types';

/**
 * Phase 3B preflight: REAL camera + microphone checks (acquire → verify →
 * release) plus network reachability, exam monitoring policy summary and
 * explicit consent. A required device that cannot be provided blocks the
 * start; optional devices only warn.
 */

type RowStatus = 'pending' | 'pass' | 'warn' | 'fail';

interface CheckRow {
  key: string;
  label: string;
  detail: string;
  status: RowStatus;
  blocking: boolean;
}

function reasonLabel(reason: 'denied' | 'unavailable' | 'error' | undefined, device: string): string {
  switch (reason) {
    case 'denied':
      return `${device} permission denied — enable access in your system settings`;
    case 'unavailable':
      return `No ${device.toLowerCase()} found`;
    default:
      return `${device} could not be verified`;
  }
}

function policySummary(settings: ExamSettingsLike | null | undefined): string[] {
  const s = settings;
  const items: string[] = [];
  if (s?.cameraRequired) items.push('camera monitoring active');
  if (s?.microphoneRequired) items.push('microphone monitoring active');
  if (s?.screenMonitoringRequired) items.push('screen monitoring active');
  if (s?.clipboardPolicy === 'BLOCK') items.push('copy/paste restricted');
  if (s?.clipboardPolicy === 'NOTIFY') items.push('clipboard use recorded');
  if (s?.fullScreenPolicy === 'REQUIRED') items.push('full-screen mode');
  if (s?.appSwitchPolicy === 'BLOCK') items.push('app switching restricted');
  if (s?.appSwitchPolicy === 'DETECT') items.push('app switching recorded');
  if (s?.identityVerificationRequired) items.push('identity verification may be requested');
  if (items.length === 0) items.push('no additional monitoring beyond answers');
  return items;
}

export function PreflightScreen({
  exam,
  online,
  onStart,
  onBack,
}: {
  exam: AssignedExam;
  online: boolean;
  onStart: (consent: Record<string, unknown>) => void;
  onBack: () => Promise<void>;
}) {
  const settings = exam.settings;
  const cameraReq = settings?.cameraRequired ?? true;
  const micReq = settings?.microphoneRequired ?? true;
  const screenReq = settings?.screenMonitoringRequired ?? true;

  const summary = useMemo(() => policySummary(settings), [settings]);

  const [rows, setRows] = useState<CheckRow[]>([]);
  const [running, setRunning] = useState(true);
  const [consentChecked, setConsentChecked] = useState(false);
  const [availableCameras, setAvailableCameras] = useState<
    Array<{ deviceId: string; label: string; isVirtual: boolean; isBuiltIn: boolean; isPreferred: boolean }>
  >([]);
  const [selectedCameraId, setSelectedCameraId] = useState<string | undefined>(undefined);

  const patchRow = (key: string, patch: Partial<CheckRow>) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  async function runChecks(targetCameraId?: string) {
    setRunning(true);
    setRows([
      { key: 'network', label: 'Network', detail: online ? 'Connected to ExamGuard' : 'Offline', status: online ? 'pass' : 'fail', blocking: true },
      { key: 'camera', label: 'Camera', detail: 'Checking…', status: 'pending', blocking: cameraReq },
      { key: 'mic', label: 'Microphone', detail: 'Checking…', status: 'pending', blocking: micReq },
      { key: 'screen', label: 'Screen capture', detail: 'Checking…', status: 'pending', blocking: screenReq },
    ]);

    const activeCamId = targetCameraId ?? selectedCameraId;

    // Camera — live acquire + release when required, presence probe otherwise.
    if (cameraReq) {
      const res = await preflightDevice('camera', activeCamId);
      if (res.ok) {
        patchRow('camera', { status: 'pass', detail: res.label ? `Camera ready (${res.label})` : 'Camera ready' });
      } else {
        patchRow('camera', { status: 'fail', detail: reasonLabel(res.reason, 'Camera') });
      }
    } else {
      const probe = await probeAvailability();
      const state = probe.cameraCount > 0 ? 'pass' : 'warn';
      patchRow('camera', {
        status: state,
        detail: state === 'pass' ? 'Camera available (not required)' : 'No camera found (not required)',
      });
    }

    const cams = await getAvailableCameras();
    setAvailableCameras(cams);
    if (!activeCamId && cams.length > 0) {
      const pref = cams.find((c) => c.isPreferred) ?? cams[0];
      if (pref) setSelectedCameraId(pref.deviceId);
    }

    // Microphone — same treatment.
    if (micReq) {
      const res = await preflightDevice('microphone');
      if (res.ok) {
        patchRow('mic', { status: 'pass', detail: 'Microphone ready' });
      } else {
        patchRow('mic', { status: 'fail', detail: reasonLabel(res.reason, 'Microphone') });
      }
    } else {
      const probe = await probeAvailability();
      const state = probe.micCount > 0 ? 'pass' : 'warn';
      patchRow('mic', {
        status: state,
        detail: state === 'pass' ? 'Microphone available (not required)' : 'No microphone found (not required)',
      });
    }

    // Screen — REAL whole-display capture check (acquire the primary display,
    // verify, release). Required screen capture blocks the start when it fails.
    if (screenReq) {
      const res = await preflightScreenSource();
      if (res.ok) {
        patchRow('screen', { status: 'pass', detail: 'Screen capture ready (entire display)' });
      } else {
        patchRow('screen', { status: 'fail', detail: reasonLabel(res.reason, 'Screen capture') });
      }
    } else {
      const sources = await bridge().listScreenSources().catch(() => []);
      patchRow('screen', {
        status: sources.length > 0 ? 'pass' : 'warn',
        detail:
          sources.length > 0
            ? 'Screen available (not required by this exam)'
            : 'No screen source found (not required by this exam)',
      });
    }

    const info = await bridge()
      .getAppInfo()
      .then((i: { displayCount: number }) => i.displayCount)
      .catch(() => 1);
    if (info > 1) {
      setRows((prev) => [
        ...prev.filter((r) => r.key !== 'display'),
        { key: 'display', label: 'Displays', detail: `${info} displays detected — additional screens may be recorded`, status: 'warn', blocking: false },
      ]);
    }
    setRunning(false);
  }

  useEffect(() => {
    void runChecks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const requiredFail = rows.some((r) => r.blocking && r.status === 'fail');
  const stillRunning = running || rows.some((r) => r.status === 'pending');
  const canStart = online && consentChecked && !requiredFail && !stillRunning;

  function start() {
    const cameraOk = rows.find((r) => r.key === 'camera')?.status === 'pass';
    const micOk = rows.find((r) => r.key === 'mic')?.status === 'pass';
    const screenOk = rows.find((r) => r.key === 'screen')?.status === 'pass';
    onStart({
      camera: cameraReq && cameraOk,
      microphone: micReq && micOk,
      screen: screenReq && screenOk,
      selectedCameraId,
      screenAccepted: screenReq,
      acceptedAt: new Date().toISOString(),
    });
  }

  const handleCameraChange = (deviceId: string) => {
    setSelectedCameraId(deviceId);
    void runChecks(deviceId);
  };

  return (
    <div className="page">
      <header className="topbar">
        <div>
          <strong>ExamGuard</strong>
          <span className="muted"> — device check</span>
        </div>
        <button className="btn ghost" onClick={() => void onBack()}>
          ← Exams
        </button>
      </header>
      <main className="content narrow">
        <h2>{exam.name}</h2>
        <p className="muted">
          Before you start, ExamGuard verifies the devices this exam requires. Monitoring is announced, never hidden.
        </p>

        <ul className="check-list">
          {rows.map((r) => (
            <li key={r.key} className={`check-item ${r.status}`}>
              <span className="check-mark">
                {r.status === 'pass' ? '✓' : r.status === 'fail' ? '✕' : r.status === 'warn' ? '⚠' : '…'}
              </span>
              <span className="check-label">
                {r.label}
                {r.blocking && <em> (required)</em>}
              </span>
              <span className="check-detail">{r.detail}</span>
            </li>
          ))}
        </ul>

        <div className="policy-box">
          <strong>This exam:</strong>
          <ul>
            {summary.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>

        {requiredFail && (
          <p className="error">
            A required device could not be verified. Grant the permission or connect the device, then re-check.
          </p>
        )}

        <label className="consent-block">
          <input type="checkbox" checked={consentChecked} onChange={(e) => setConsentChecked(e.target.checked)} />
          <span>
            I understand the monitoring described above is active during this exam, my answers and session activity
            are recorded, and the exam is subject to the institution&apos;s academic integrity policy.
          </span>
        </label>

        <div className="row-gap right">
          <button className="btn ghost" onClick={() => void runChecks()} disabled={running}>
            Re-check devices
          </button>
          <button className="btn" disabled={!canStart} onClick={start}>
            Start secure exam
          </button>
        </div>
        {!canStart && !requiredFail && !stillRunning && !consentChecked && (
          <p className="muted small">Please confirm the statement above to continue.</p>
        )}
      </main>
    </div>
  );
}
