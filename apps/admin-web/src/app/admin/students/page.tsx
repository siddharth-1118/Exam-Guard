'use client';

import { useEffect, useState } from 'react';
import { Badge, Button, Card, CardBody, CardHeader, PageHeader, Spinner, Alert } from '@examguard/ui';
import { StudentForm } from '@/components/student-form';

interface Student {
  id: string;
  studentCode: string;
  email: string;
  firstName: string;
  lastName: string;
  isActive: boolean;
}

export default function StudentsPage() {
  const [students, setStudents] = useState<Student[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const load = async () => {
    setError(null);
    try {
      const res = await fetch('/api/gate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: '/students', method: 'GET' }),
      });
      const data = (await res.json()) as Student[] | { error?: string };
      if (!res.ok) throw new Error((data as { error?: string }).error ?? 'Failed to load');
      setStudents(data as Student[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load students');
    }
  };

  useEffect(() => {
    void load();
  }, []);

  return (
    <>
      <PageHeader title="Students" description="Registered student accounts in your organization." actions={<Button onClick={() => setOpen(true)}>+ Add Student</Button>} />
      <StudentForm open={open} onClose={() => setOpen(false)} />
      {error && <div className="mb-4"><Alert tone="danger">{error}</Alert></div>}
      <Card>
        <CardHeader title="All students" />
        <CardBody className="p-0">
          {students === null ? (
            <div className="flex justify-center py-10"><Spinner /></div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-5 py-3">Code</th>
                  <th className="px-5 py-3">Name</th>
                  <th className="px-5 py-3">Email</th>
                  <th className="px-5 py-3">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {students.map((s) => (
                  <tr key={s.id} className="hover:bg-slate-50">
                    <td className="px-5 py-3 font-mono text-xs text-slate-500">{s.studentCode}</td>
                    <td className="px-5 py-3 font-medium text-slate-900">{s.firstName} {s.lastName}</td>
                    <td className="px-5 py-3 text-slate-600">{s.email}</td>
                    <td className="px-5 py-3">{s.isActive ? <Badge tone="green">active</Badge> : <Badge tone="red">inactive</Badge>}</td>
                  </tr>
                ))}
                {students.length === 0 && (
                  <tr><td className="px-5 py-8 text-center text-slate-400" colSpan={4}>No students yet.</td></tr>
                )}
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>
    </>
  );
}