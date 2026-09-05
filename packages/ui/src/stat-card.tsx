import React from 'react';
import { Card, cn } from './index';

export function StatCard({
  label,
  value,
  icon,
  tone = 'slate',
}: {
  label: string;
  value: React.ReactNode;
  icon?: React.ReactNode;
  tone?: 'slate' | 'green' | 'yellow' | 'red' | 'indigo';
}) {
  const tones = {
    slate: 'text-slate-600',
    green: 'text-emerald-600',
    yellow: 'text-amber-600',
    red: 'text-red-600',
    indigo: 'text-indigo-600',
  };
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
        {icon && <span className={cn('text-xl', tones[tone])} aria-hidden="true">{icon}</span>}
      </div>
      <p className={cn('mt-2 text-3xl font-bold tracking-tight text-slate-900', tones[tone])}>{value}</p>
    </Card>
  );
}