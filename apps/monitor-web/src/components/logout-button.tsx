'use client';

import { useRouter } from 'next/navigation';
import { Button } from '@examguard/ui';

export function LogoutButton() {
  const router = useRouter();
  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
    router.refresh();
  };
  return (
    <Button variant="ghost" size="sm" onClick={logout} className="text-slate-300 hover:bg-slate-800">
      Sign out
    </Button>
  );
}