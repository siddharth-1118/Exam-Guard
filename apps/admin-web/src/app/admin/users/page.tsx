'use client';

import { useEffect, useState } from 'react';
import { Badge, Button, Card, CardBody, CardHeader, PageHeader, Spinner, Alert } from '@examguard/ui';
import { UserForm } from '@/components/user-form';

interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  isActive: boolean;
}

const roleTone = (role: string): 'indigo' | 'blue' | 'yellow' | 'green' | 'slate' =>
  role === 'SUPER_ADMIN' ? 'indigo' : role === 'ORG_ADMIN' ? 'blue' : role === 'EXAM_MANAGER' ? 'yellow' : role === 'MONITOR' ? 'green' : 'slate';

export default function UsersPage() {
  const [users, setUsers] = useState<User[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const load = async () => {
    try {
      const res = await fetch('/api/gate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: '/users', method: 'GET' }),
      });
      const data = (await res.json()) as User[] | { error?: string };
      if (!res.ok) throw new Error((data as { error?: string }).error ?? 'Failed to load');
      setUsers(data as User[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load users');
    }
  };

  useEffect(() => {
    void load();
  }, []);

  return (
    <>
      <PageHeader title="Users & Roles" description="Organization members and their role-based access." actions={<Button onClick={() => setOpen(true)}>+ Create User</Button>} />
      <UserForm open={open} onClose={() => setOpen(false)} />
      {error && <div className="mb-4"><Alert tone="danger">{error}</Alert></div>}
      <Card>
        <CardBody className="p-0">
          {users === null ? (
            <div className="flex justify-center py-10"><Spinner /></div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-5 py-3">Name</th>
                  <th className="px-5 py-3">Email</th>
                  <th className="px-5 py-3">Role</th>
                  <th className="px-5 py-3">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {users.map((u) => (
                  <tr key={u.id} className="hover:bg-slate-50">
                    <td className="px-5 py-3 font-medium text-slate-900">{u.firstName} {u.lastName}</td>
                    <td className="px-5 py-3 text-slate-600">{u.email}</td>
                    <td className="px-5 py-3"><Badge tone={roleTone(u.role)}>{u.role.replaceAll('_', ' ')}</Badge></td>
                    <td className="px-5 py-3">{u.isActive ? <Badge tone="green">active</Badge> : <Badge tone="red">inactive</Badge>}</td>
                  </tr>
                ))}
                {users.length === 0 && <tr><td className="px-5 py-8 text-center text-slate-400" colSpan={4}>No users found.</td></tr>}
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>
    </>
  );
}