'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, Modal } from '@examguard/ui';
import { gate } from '@/lib/gate';

export function DeleteExamButton({ examId, examName }: { examId: string; examName: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await gate(`/exams/${examId}`, 'DELETE');
      setOpen(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)} className="text-red-600 hover:bg-red-50">
        Delete
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Delete exam">
        <p className="text-sm text-slate-600">
          Delete <strong>{examName}</strong>? This action cannot be undone and is recorded in the audit log.
        </p>
        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="danger" onClick={confirm} loading={busy}>Delete exam</Button>
        </div>
      </Modal>
    </>
  );
}