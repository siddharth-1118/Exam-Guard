'use client';

import { useEffect, useState } from 'react';
import { Badge, Card, CardBody, CardHeader, PageHeader, Spinner, Alert } from '@examguard/ui';

interface Org {
  id: string;
  name: string;
  slug: string;
  plan: string;
  status: string;
  createdAt: string;
}

export default function OrganizationsPage() {
  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/gate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/organizations', method: 'GET' }),
    })
      .then(async (res) => {
        const data = (await res.json()) as Org[] | { error?: string };
        if (!res.ok) throw new Error((data as { error?: string }).error ?? 'Failed');
        setOrgs(data as Org[]);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load organizations'));
  }, []);

  return (
    <>
      <PageHeader title="Organizations" description="Tenants on the platform (super admin only)." />
      {error && <Alert tone="danger">{error}</Alert>}
      <Card className="mt-4">
        <CardHeader title="Tenants" />
        <CardBody className="p-0">
          {orgs === null ? (
            <div className="flex justify-center py-10"><Spinner /></div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-5 py-3">Organization</th>
                  <th className="px-5 py-3">Slug</th>
                  <th className="px-5 py-3">Plan</th>
                  <th className="px-5 py-3">Status</th>
                  <th className="px-5 py-3">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {orgs.map((o) => (
                  <tr key={o.id} className="hover:bg-slate-50">
                    <td className="px-5 py-3 font-medium text-slate-900">{o.name}</td>
                    <td className="px-5 py-3 font-mono text-xs text-slate-500">{o.slug}</td>
                    <td className="px-5 py-3"><Badge tone="indigo">{o.plan}</Badge></td>
                    <td className="px-5 py-3"><Badge tone={o.status === 'ACTIVE' ? 'green' : 'red'}>{o.status}</Badge></td>
                    <td className="px-5 py-3 text-xs text-slate-500">{new Date(o.createdAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>
    </>
  );
}