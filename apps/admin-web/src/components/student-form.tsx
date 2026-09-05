'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Input, Modal, Alert } from '@examguard/ui';
import { gate } from '@/lib/gate';

export function StudentForm({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const [form, setForm] = useState({ email: '', firstName: '', lastName: '', studentCode: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await gate('/students', 'POST', { ...form, password: 'Student!Temp2026' });
      setForm({ email: '', firstName: '', lastName: '', studentCode: '' });
      onClose();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add student');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Add student">
      <div className="space-y-3">
        <Input label="Full name (first)" value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} />
        <Input label="Last name" value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} />
        <Input label="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        <Input label="Student code" value={form.studentCode} onChange={(e) => setForm({ ...form, studentCode: e.target.value })} hint="e.g. NS-2026-042" />
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} loading={busy}>Create account</Button>
        </div>
      </div>
    </Modal>
  );
}