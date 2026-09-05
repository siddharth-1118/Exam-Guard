'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Card, CardBody, Checkbox, Input, PageHeader, Select, Textarea, Alert } from '@examguard/ui';
import { gate } from '@/lib/gate';

const POLICY_DEFAULTS = {
  cameraRequired: true,
  microphoneRequired: true,
  screenMonitoringRequired: true,
  identityVerificationRequired: true,
  aiProctoringEnabled: true,
  clipboardPolicy: 'BLOCK',
  fullScreenPolicy: 'REQUIRED',
  appSwitchPolicy: 'BLOCK',
  multipleFacePolicy: 'ALERT',
  phoneObjectDetection: true,
  allowOfflineMode: true,
  evidencePolicy: 'EVENT_ONLY',
  retentionDays: 90,
};

export function ExamCreateForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    name: '',
    description: '',
    instructions: '',
    durationMinutes: '60',
    maxAttempts: '1',
    passingScore: '40',
    negativeMarkingEnabled: false,
    negativeMarkingValue: '0.25',
    shuffleQuestions: false,
    shuffleOptions: false,
    autoSubmit: true,
    status: 'DRAFT',
    startAt: '',
    endAt: '',
    settings: { ...POLICY_DEFAULTS },
  });

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const setSetting = <K extends keyof typeof POLICY_DEFAULTS>(key: K, value: (typeof POLICY_DEFAULTS)[K]) =>
    setForm((f) => ({ ...f, settings: { ...f.settings, [key]: value } }));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const exam = await gate<{ id: string }>('/exams', 'POST', {
        name: form.name,
        description: form.description || undefined,
        instructions: form.instructions || undefined,
        durationMinutes: Number(form.durationMinutes),
        maxAttempts: Number(form.maxAttempts),
        passingScore: Number(form.passingScore),
        negativeMarkingEnabled: form.negativeMarkingEnabled,
        negativeMarkingValue: Number(form.negativeMarkingValue),
        shuffleQuestions: form.shuffleQuestions,
        shuffleOptions: form.shuffleOptions,
        autoSubmit: form.autoSubmit,
        status: form.status,
        startAt: form.startAt ? new Date(form.startAt).toISOString() : undefined,
        endAt: form.endAt ? new Date(form.endAt).toISOString() : undefined,
        settings: form.settings,
      });
      router.push(`/admin/exams/${exam.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create exam');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-4xl space-y-6">
      <Card>
        <div className="border-b border-slate-100 px-5 py-4"><h3 className="text-sm font-semibold">General</h3></div>
        <CardBody className="space-y-4">
          <Input label="Exam name *" required value={form.name} onChange={(e) => set('name', e.target.value)} />
          <Textarea label="Description" rows={2} value={form.description} onChange={(e) => set('description', e.target.value)} />
          <Textarea label="Instructions shown to students" rows={3} value={form.instructions} onChange={(e) => set('instructions', e.target.value)} />
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <Input label="Duration (min)" type="number" min={1} value={form.durationMinutes} onChange={(e) => set('durationMinutes', e.target.value)} />
            <Input label="Max attempts" type="number" min={1} max={10} value={form.maxAttempts} onChange={(e) => set('maxAttempts', e.target.value)} />
            <Input label="Passing score (%)" type="number" value={form.passingScore} onChange={(e) => set('passingScore', e.target.value)} />
            <Input label="Negative marks / wrong" type="number" step="0.25" min={0} value={form.negativeMarkingValue} onChange={(e) => set('negativeMarkingValue', e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Input label="Scheduled start" type="datetime-local" value={form.startAt} onChange={(e) => set('startAt', e.target.value)} />
            <Input label="Scheduled end" type="datetime-local" value={form.endAt} onChange={(e) => set('endAt', e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            <Checkbox label="Randomize question order" checked={form.shuffleQuestions} onChange={(e) => set('shuffleQuestions', e.target.checked)} />
            <Checkbox label="Randomize option order" checked={form.shuffleOptions} onChange={(e) => set('shuffleOptions', e.target.checked)} />
            <Checkbox label="Negative marking" checked={form.negativeMarkingEnabled} onChange={(e) => set('negativeMarkingEnabled', e.target.checked)} />
            <Checkbox label="Auto-submit at deadline" checked={form.autoSubmit} onChange={(e) => set('autoSubmit', e.target.checked)} />
          </div>
          <Select
            label="Initial status"
            value={form.status}
            onChange={(e) => set('status', e.target.value as typeof form.status)}
            options={[
              { value: 'DRAFT', label: 'Draft' },
              { value: 'SCHEDULED', label: 'Scheduled' },
              { value: 'OPEN', label: 'Open (students can start)' },
            ]}
          />
        </CardBody>
      </Card>

      <Card>
        <div className="border-b border-slate-100 px-5 py-4">
          <h3 className="text-sm font-semibold">Security &amp; Proctoring Policy</h3>
          <p className="text-xs text-slate-500">Enforced by the secure app and monitor console; visible to students before consent.</p>
        </div>
        <CardBody className="space-y-5">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            <Checkbox label="Camera required" checked={form.settings.cameraRequired} onChange={(e) => setSetting('cameraRequired', e.target.checked)} />
            <Checkbox label="Microphone required" checked={form.settings.microphoneRequired} onChange={(e) => setSetting('microphoneRequired', e.target.checked)} />
            <Checkbox label="Screen monitoring required" checked={form.settings.screenMonitoringRequired} onChange={(e) => setSetting('screenMonitoringRequired', e.target.checked)} />
            <Checkbox label="Identity verification required" checked={form.settings.identityVerificationRequired} onChange={(e) => setSetting('identityVerificationRequired', e.target.checked)} />
            <Checkbox label="AI proctoring" checked={form.settings.aiProctoringEnabled} onChange={(e) => setSetting('aiProctoringEnabled', e.target.checked)} />
            <Checkbox label="Phone / object detection" checked={form.settings.phoneObjectDetection} onChange={(e) => setSetting('phoneObjectDetection', e.target.checked)} />
            <Checkbox label="Allow offline mode" checked={form.settings.allowOfflineMode} onChange={(e) => setSetting('allowOfflineMode', e.target.checked)} />
          </div>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
            <Select label="Clipboard policy" value={form.settings.clipboardPolicy} onChange={(e) => setSetting('clipboardPolicy', e.target.value)} options={[
              { value: 'BLOCK', label: 'Block clipboard' },
              { value: 'NOTIFY', label: 'Notify on use' },
              { value: 'ALLOW', label: 'Allow' },
            ]} />
            <Select label="Fullscreen policy" value={form.settings.fullScreenPolicy} onChange={(e) => setSetting('fullScreenPolicy', e.target.value)} options={[
              { value: 'REQUIRED', label: 'Required' },
              { value: 'RECOMMENDED', label: 'Recommended' },
              { value: 'NOT_REQUIRED', label: 'Not required' },
            ]} />
            <Select label="App switching" value={form.settings.appSwitchPolicy} onChange={(e) => setSetting('appSwitchPolicy', e.target.value)} options={[
              { value: 'BLOCK', label: 'Block where supported' },
              { value: 'DETECT', label: 'Detect & alert' },
              { value: 'ALLOW', label: 'Allow' },
            ]} />
            <Select label="Multiple faces" value={form.settings.multipleFacePolicy} onChange={(e) => setSetting('multipleFacePolicy', e.target.value)} options={[
              { value: 'ALERT', label: 'Alert monitor' },
              { value: 'BLOCK', label: 'Block exam' },
              { value: 'ALLOW', label: 'Allow' },
            ]} />
            <Select label="Evidence recording" value={form.settings.evidencePolicy} onChange={(e) => setSetting('evidencePolicy', e.target.value)} options={[
              { value: 'EVENT_ONLY', label: 'Evidence around events only (default)' },
              { value: 'FULL_RECORDING', label: 'Continuous recording' },
              { value: 'NONE', label: 'None' },
            ]} />
            <Input label="Retention (days)" type="number" min={1} max={3650} value={String(form.settings.retentionDays)} onChange={(e) => setSetting('retentionDays', Number(e.target.value))} />
          </div>
          <p className="text-xs text-slate-400">
            Recording/evidence defaults to event-only with a {form.settings.retentionDays}-day retention period, per privacy policy.
          </p>
        </CardBody>
      </Card>

      {error && <Alert tone="danger">{error}</Alert>}
      <div className="flex justify-end gap-2 pb-8">
        <Button variant="secondary" onClick={() => router.push('/admin/exams')}>Cancel</Button>
        <Button onClick={submit} loading={busy} disabled={!form.name.trim()}>Create exam</Button>
      </div>
    </div>
  );
}