'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Card, Input } from '@examguard/ui';

export default function StudentLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = (await res.json()) as { redirect?: string; allowedPortal?: boolean; error?: string };
      if (!res.ok || !data.redirect) {
        setError(data.error ?? 'Login failed');
        return;
      }
      if (!data.allowedPortal) {
        setError('This account is not a student. Sign in to the correct portal (admin or monitor).');
        return;
      }
      router.push(data.redirect);
      router.refresh();
    } catch {
      setError('Unable to reach the server. Is the API running on port 4000?');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 px-4">
      <Card className="w-full max-w-md p-8">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-indigo-600 text-xl font-bold text-white">EG</div>
          <h1 className="text-xl font-bold text-slate-900">Student sign in</h1>
          <p className="mt-1 text-sm text-slate-500">Access your assigned examinations</p>
        </div>
        <form onSubmit={submit} className="space-y-4">
          <Input label="Email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          <Input label="Password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <Button type="submit" loading={loading} className="w-full">Sign in</Button>
        </form>
        <p className="mt-6 text-center text-xs text-slate-400">
          Demo: student01@northstar.edu — ExamGuard!Dev2026 (dev only)
        </p>
      </Card>
    </main>
  );
}