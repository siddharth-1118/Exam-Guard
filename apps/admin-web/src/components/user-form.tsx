'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Input, Modal, Select, Alert } from '@examguard/ui';
import { gate } from '@/lib/gate';

export function UserForm({
  open,
  onClose,
  defaultRole = 'EXAM_MANAGER',
}: {
  open: boolean;
  onClose: () => void;
  defaultRole?: string;
}) {
  const router = useRouter();
  const [form, setForm] = useState({ email: '', firstName: '', lastName: '', role: defaultRole });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await gate('/users', 'POST', { ...form, password: 'Staff!Temp2026' });
      setForm({ email: '', firstName: '', lastName: '', role: defaultRole });
      onClose();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create user');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Create user">
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Input label="First name" value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} />
          <Input label="Last name" value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} />
        </div>
        <Input label="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        <Select
          label="Role"
          value={form.role}
          onChange={(e) => setForm({ ...form, role: e.target.value })}
          options={[
            { value: 'ORG_ADMIN', label: 'Organization Admin' },
            { value: 'EXAM_MANAGER', label: 'Exam Manager / Teacher' },
            { value: 'MONITOR', label: 'Monitor / Proctor' },
            { value: 'STUDENT', label: 'Student' },
          ]}
        />
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} loading={busy}>Create user</Button>
        </div>
      </div>
    </Modal>
  );
}