'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Badge, Button, Card, CardBody, PageHeader } from '@examguard/ui';
import { gate } from '@/lib/gate';

interface Student {
  attemptId: string | null;
  studentId: string;
  studentName: string;
  studentCode: string;
  status: string;
  riskScore: number;
  riskLevel: string;
  cameraConnected: boolean;
  micConnected: boolean;
  screenConnected: boolean;
}

const riskTone = (level: string, score: number): 'red' | 'yellow' | 'blue' | 'green' | 'slate' =>
  level === 'CRITICAL' ? 'red' : level === 'SUSPICIOUS' ? 'yellow' : level === 'LOW_CONCERN' ? 'blue' : score > 0 ? 'green' : 'slate';

export default function MonitorBoard() {
  const params = useParams<{ examId: string }>();
  const examId = params.examId;
  const [students, setStudents] = useState<Student[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [grid, setGrid] = useState<'2' | '3' | '4'>('4');
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const polling = useRef(true);

  const load = useCallback(async () => {
    try {
      const data = await gate<Student[]>(`/monitoring/exams/${examId}/students`, 'GET');
      setStudents(data);
      setLastUpdated(new Date());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    }
  }, [examId]);

  useEffect(() => {
    void load();
    const t = setInterval(() => {
      if (polling.current) void load();
    }, 8_000);
    return () => clearInterval(t);
  }, [load]);

  const [search, setSearch] = useState('');
  const [filterRisk, setFilterRisk] = useState<string>('ALL');
  const [page, setPage] = useState(1);
  const pageSize = 24;

  const counts = {
    critical: students.filter((s) => s.riskLevel === 'CRITICAL' || s.status === 'TERMINATED').length,
    suspicious: students.filter((s) => s.riskLevel === 'SUSPICIOUS' || s.status === 'PAUSED' || s.status === 'DISCONNECTED').length,
    normal: students.filter((s) => !['CRITICAL', 'SUSPICIOUS', 'PAUSED', 'DISCONNECTED', 'TERMINATED'].includes(s.riskLevel) && !['PAUSED', 'DISCONNECTED', 'TERMINATED'].includes(s.status) || s.status === 'ACTIVE').length,
  };

  const filteredStudents = students.filter((s) => {
    const matchesSearch =
      !search ||
      s.studentName.toLowerCase().includes(search.toLowerCase()) ||
      s.studentCode.toLowerCase().includes(search.toLowerCase());
    const matchesRisk =
      filterRisk === 'ALL' ||
      (filterRisk === 'CRITICAL' && (s.riskLevel === 'CRITICAL' || s.status === 'TERMINATED')) ||
      (filterRisk === 'SUSPICIOUS' && (s.riskLevel === 'SUSPICIOUS' || s.status === 'PAUSED' || s.status === 'DISCONNECTED')) ||
      (filterRisk === 'NORMAL' && s.riskLevel === 'NORMAL');
    return matchesSearch && matchesRisk;
  });

  const totalPages = Math.ceil(filteredStudents.length / pageSize) || 1;
  const currentPage = Math.min(page, totalPages);
  const paginatedStudents = filteredStudents.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  const gridCols =
    grid === '2' ? 'sm:grid-cols-2' : grid === '3' ? 'sm:grid-cols-2 lg:grid-cols-3' : 'sm:grid-cols-2 lg:grid-cols-4';

  return (
    <>
      <PageHeader
        title={`Monitoring Board — Exam`}
        description={`Polling every 8s (last update ${lastUpdated?.toLocaleTimeString() ?? '—'}). Thumbnail-grade tiles; focused student detail opens on click.`}
        actions={
          <div className="flex items-center gap-1 rounded-lg bg-slate-900 p-1">
            {(['2', '3', '4'] as const).map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => setGrid(g)}
                aria-label={`${g}x${g} grid`}
                className={`rounded px-2.5 py-1 text-xs font-medium ${grid === g ? 'bg-red-600 text-white' : 'text-slate-400 hover:text-white'}`}
              >
                {g}x{g}
              </button>
            ))}
          </div>
        }
      />

      <div className="mb-4 grid grid-cols-3 gap-3">
        <div
          onClick={() => { setFilterRisk('CRITICAL'); setPage(1); }}
          className="cursor-pointer rounded-xl border border-red-900/50 bg-red-950/40 p-4 transition-colors hover:border-red-600"
        >
          <p className="text-2xl font-bold text-red-400">{counts.critical}</p>
          <p className="text-xs uppercase tracking-wide text-red-300/70">🔴 Critical</p>
        </div>
        <div
          onClick={() => { setFilterRisk('SUSPICIOUS'); setPage(1); }}
          className="cursor-pointer rounded-xl border border-amber-900/50 bg-amber-950/30 p-4 transition-colors hover:border-amber-600"
        >
          <p className="text-2xl font-bold text-amber-400">{counts.suspicious}</p>
          <p className="text-xs uppercase tracking-wide text-amber-300/70">🟡 Suspicious</p>
        </div>
        <div
          onClick={() => { setFilterRisk('NORMAL'); setPage(1); }}
          className="cursor-pointer rounded-xl border border-emerald-900/50 bg-emerald-950/30 p-4 transition-colors hover:border-emerald-600"
        >
          <p className="text-2xl font-bold text-emerald-400">{counts.normal}</p>
          <p className="text-xs uppercase tracking-wide text-emerald-300/70">🟢 Normal</p>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900 p-3">
        <div className="flex flex-1 items-center gap-3">
          <input
            type="text"
            placeholder="Search student name or code..."
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            className="w-full max-w-xs rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs text-white placeholder-slate-500 focus:border-red-500 focus:outline-none"
          />
          <select
            value={filterRisk}
            onChange={(e) => { setFilterRisk(e.target.value); setPage(1); }}
            className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs text-white focus:border-red-500 focus:outline-none"
          >
            <option value="ALL">All Risk Levels ({students.length})</option>
            <option value="CRITICAL">Critical Only ({counts.critical})</option>
            <option value="SUSPICIOUS">Suspicious Only ({counts.suspicious})</option>
            <option value="NORMAL">Normal Only ({counts.normal})</option>
          </select>
        </div>
        {totalPages > 1 && (
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <button
              type="button"
              disabled={currentPage <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="rounded border border-slate-700 px-2 py-1 disabled:opacity-40"
            >
              Prev
            </button>
            <span>
              Page {currentPage} of {totalPages}
            </span>
            <button
              type="button"
              disabled={currentPage >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="rounded border border-slate-700 px-2 py-1 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        )}
      </div>

      {error && <p className="mb-3 text-sm text-red-400">{error}</p>}

      <div className={`grid grid-cols-1 gap-3 ${gridCols}`}>
        {paginatedStudents.map((s) => {
          const attention = s.riskLevel === 'CRITICAL' || s.status === 'TERMINATED';
          const concern = s.riskLevel === 'SUSPICIOUS' || s.status === 'PAUSED' || s.status === 'DISCONNECTED';
          return (
            <Link
              key={s.studentId}
              href={`/monitor/students/${s.studentId}`}
              className={`rounded-xl border p-4 transition-colors hover:border-red-500/60 ${
                attention
                  ? 'border-red-900 bg-red-950/50'
                  : concern
                    ? 'border-amber-900/70 bg-amber-950/30'
                    : 'border-slate-800 bg-slate-900'
              }`}
            >
              <div className="mb-2 flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold text-white">{s.studentName}</p>
                  <p className="font-mono text-[10px] text-slate-500">{s.studentCode}</p>
                </div>
                {attention ? <span className="text-lg" aria-label="critical">🔴</span> : concern ? <span className="text-lg" aria-label="suspicious">🟡</span> : <span className="text-lg" aria-label="normal">🟢</span>}
              </div>
              <div className="mb-2 flex flex-wrap items-center gap-1.5">
                <Badge tone={riskTone(s.riskLevel, s.riskScore)}>
                  {s.riskLevel === 'NORMAL' ? 'normal' : s.riskLevel.replace('_', ' ')} {s.riskScore}
                </Badge>
                <Badge tone="slate">{s.status.replace('_', ' ')}</Badge>
              </div>
              <div className="flex items-center gap-3 text-[10px] text-slate-500">
                <span className="flex items-center gap-1">
                  <span className={`h-1.5 w-1.5 rounded-full ${s.cameraConnected ? 'bg-emerald-400' : 'bg-slate-600'}`} /> camera
                </span>
                <span className="flex items-center gap-1">
                  <span className={`h-1.5 w-1.5 rounded-full ${s.micConnected ? 'bg-emerald-400' : 'bg-slate-600'}`} /> mic
                </span>
                <span className="flex items-center gap-1">
                  <span className={`h-1.5 w-1.5 rounded-full ${s.screenConnected ? 'bg-emerald-400' : 'bg-slate-600'}`} /> screen
                </span>
              </div>
            </Link>
          );
        })}
        {students.length === 0 && (
          <div className="col-span-full">
            <Card className="border-slate-800 bg-slate-900">
              <CardBody>
                <p className="py-10 text-center text-sm text-slate-500">No students assigned to this exam.</p>
              </CardBody>
            </Card>
          </div>
        )}
      </div>
    </>
  );
}