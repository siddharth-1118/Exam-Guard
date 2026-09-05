'use client';

import { useEffect, useState } from 'react';
import { Badge, Button, Card, CardBody, PageHeader, Spinner, Alert, Input } from '@examguard/ui';

interface LogRow {
  id: string;
  actorEmail: string | null;
  action: string;
  resourceType: string | null;
  detail: Record<string, unknown> | null;
  ip: string | null;
  createdAt: string;
}

export default function AuditLogsPage() {
  const [rows, setRows] = useState<LogRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = async (page = 1) => {
    setError(null);
    try {
      const res = await fetch('/api/gate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: `/audit?page=${page}&pageSize=100`, method: 'GET' }),
      });
      const data = (await res.json()) as { rows?: LogRow[]; total?: number; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed');
      setRows(data.rows ?? []);
      setTotal(data.total ?? 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load audit logs');
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const filtered = (rows ?? []).filter(
    (r) =>
      (r.actorEmail ?? '').toLowerCase().includes(filter.toLowerCase()) ||
      (r.action ?? '').toLowerCase().includes(filter.toLowerCase()) ||
      (r.resourceType ?? '').toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <>
      <PageHeader title="Audit Logs" description="Append-only record of every privileged action in your organization." />
      {error && <div className="mb-4"><Alert tone="danger">{error}</Alert></div>}
      <div className="mb-4 max-w-sm">
        <Input label={`Filter (${filtered.length} of ${total} shown)`} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="actor, action, resource…" />
      </div>
      <Card>
        <CardBody className="p-0">
          {rows === null ? (
            <div className="flex justify-center py-10"><Spinner /></div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-5 py-3">When</th>
                  <th className="px-5 py-3">Actor</th>
                  <th className="px-5 py-3">Action</th>
                  <th className="px-5 py-3">IP</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.map((r) => (
                  <tr key={r.id} className="hover:bg-slate-50">
                    <td className="whitespace-nowrap px-5 py-3 text-xs text-slate-500">{new Date(r.createdAt).toLocaleString()}</td>
                    <td className="px-5 py-3 text-slate-700">{r.actorEmail ?? 'system'}</td>
                    <td className="px-5 py-3">
                      <Badge tone="slate">{r.action}</Badge>
                    </td>
                    <td className="px-5 py-3 font-mono text-xs text-slate-500">{r.ip ?? '—'}</td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr><td className="px-5 py-8 text-center text-slate-400" colSpan={4}>No audit entries match.</td></tr>
                )}
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>
    </>
  );
}