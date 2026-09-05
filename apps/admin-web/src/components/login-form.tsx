'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Card, Input } from '@examguard/ui';
import { BRAND_NAME } from '@examguard/config';

export function LoginForm() {
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
        setError(`This account (${data.error ? '' : ''}) belongs to the student or monitor portal. Please use the correct portal app.`);
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
    <Card className="w-full max-w-md p-8">
      <div className="mb-6 text-center">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-indigo-600 text-xl font-bold text-white">
          EG
        </div>
        <h1 className="text-xl font-bold text-slate-900">Sign in to {BRAND_NAME}</h1>
        <p className="mt-1 text-sm text-slate-500">Admin &amp; exam manager portal</p>
      </div>
      <form onSubmit={submit} className="space-y-4">
        <Input label="Email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <Input label="Password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <Button type="submit" loading={loading} className="w-full">
          Sign in
        </Button>
      </form>
      <p className="mt-6 text-center text-xs text-slate-400">
        Demo accounts: admin@northstar.edu · teacher@northstar.edu · superadmin@examguard.dev
        <br />
        (password: ExamGuard!Dev2026 — dev only)
      </p>
    </Card>
  );
}