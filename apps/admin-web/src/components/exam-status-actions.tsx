'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@examguard/ui';
import { gate } from '@/lib/gate';

export function ExamStatusActions({ examId, status }: { examId: string; status: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (action: 'start' | 'end') => {
    setBusy(true);
    setError(null);
    try {
      await gate(`/exams/${examId}/${action}`, 'POST');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      {error && <span className="text-xs text-red-600">{error}</span>}
      {status !== 'OPEN' && (
        <Button variant="success" onClick={() => act('start')} loading={busy}>Start exam</Button>
      )}
      {status === 'OPEN' && (
        <Button variant="secondary" onClick={() => act('end')} loading={busy}>End exam</Button>
      )}
    </div>
  );
}