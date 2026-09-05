import Link from 'next/link';

export const metadata = {
  title: 'ExamGuard | Secure Online Proctoring & Examination Platform',
  description: 'Enterprise secure examination platform featuring automated preflight verification, encrypted WebRTC proctoring, and context-isolated desktop lockdown.',
};

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-900">
      {/* Header Navigation */}
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
          <Link href="/" className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 font-bold text-white">EG</div>
            <span className="text-lg font-bold tracking-tight text-slate-900">ExamGuard</span>
          </Link>
          <div className="flex items-center gap-4 text-sm font-medium">
            <Link href="/download" className="text-slate-600 hover:text-slate-900">Download App</Link>
            <Link href="/login" className="text-slate-600 hover:text-slate-900">Student Sign In</Link>
            <Link href="/student/dashboard" className="rounded-lg bg-indigo-600 px-3.5 py-2 text-white hover:bg-indigo-700">Open Dashboard</Link>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <main className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:py-24">
        <div className="text-center">
          <div className="inline-flex items-center gap-2 rounded-full bg-indigo-50 px-3.5 py-1.5 text-xs font-semibold text-indigo-700 ring-1 ring-inset ring-indigo-700/10">
            <span>ExamGuard v0.3.0 Release Candidate</span>
          </div>
          <h1 className="mt-6 text-4xl font-extrabold tracking-tight text-slate-900 sm:text-6xl">
            Secure, Resilient & AI-Assisted Remote Proctoring
          </h1>
          <p className="mx-auto mt-6 max-w-3xl text-lg text-slate-600 leading-relaxed">
            ExamGuard provides institutional high-integrity examination environments combining secure context-isolated desktop lockdown, multi-stream WebRTC live proctoring, and server-authoritative schedule enforcement.
          </p>
          <div className="mt-8 flex items-center justify-center gap-4">
            <Link href="/download" className="rounded-xl bg-indigo-600 px-6 py-3.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700">
              Download ExamGuard App
            </Link>
            <Link href="/login" className="rounded-xl bg-white px-6 py-3.5 text-sm font-semibold text-slate-900 shadow-xs ring-1 ring-slate-200 hover:bg-slate-50">
              Student Dashboard
            </Link>
          </div>
        </div>

        {/* Feature Cards Grid */}
        <div className="mt-20 grid grid-cols-1 gap-8 md:grid-cols-3">
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xs">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 font-bold">1</div>
            <h3 className="mt-4 text-lg font-bold text-slate-900">Secure Desktop Lockdown</h3>
            <p className="mt-2 text-sm text-slate-600 leading-relaxed">
              Electron kiosk with contextIsolation, sandbox enforcement, window navigation blocking, DevTools prevention, and multi-display detection.
            </p>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xs">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 font-bold">2</div>
            <h3 className="mt-4 text-lg font-bold text-slate-900">WebRTC SFU Live Streaming</h3>
            <p className="mt-2 text-sm text-slate-600 leading-relaxed">
              Mediasoup SFU streaming camera, microphone, and screen capture simultaneously to live proctor monitoring consoles.
            </p>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xs">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 font-bold">3</div>
            <h3 className="mt-4 text-lg font-bold text-slate-900">Server-Authoritative Timing</h3>
            <p className="mt-2 text-sm text-slate-600 leading-relaxed">
              Strict start/end schedule checks, clock manipulation prevention, pause accumulator calculations, and automated attempt submission.
            </p>
          </div>
        </div>

        {/* Access Links */}
        <div className="mt-16 rounded-2xl border border-slate-200 bg-white p-8 shadow-xs">
          <h2 className="text-xl font-bold text-slate-900">ExamGuard Ecosystem Portals</h2>
          <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Link href="/login" className="flex flex-col justify-between rounded-xl border border-slate-200 bg-slate-50 p-4 hover:border-indigo-300">
              <div>
                <span className="text-xs font-semibold text-indigo-600 uppercase tracking-wider">Student Portal</span>
                <h4 className="mt-1 font-bold text-slate-900 text-sm">Student Dashboard & Exams</h4>
              </div>
              <span className="mt-4 text-xs font-medium text-indigo-600">Access Portal →</span>
            </Link>

            <Link href="/download" className="flex flex-col justify-between rounded-xl border border-slate-200 bg-slate-50 p-4 hover:border-indigo-300">
              <div>
                <span className="text-xs font-semibold text-indigo-600 uppercase tracking-wider">Desktop Client</span>
                <h4 className="mt-1 font-bold text-slate-900 text-sm">Download Windows App</h4>
              </div>
              <span className="mt-4 text-xs font-medium text-indigo-600">View Downloads →</span>
            </Link>

            <div className="flex flex-col justify-between rounded-xl border border-slate-200 bg-slate-50 p-4">
              <div>
                <span className="text-xs font-semibold text-indigo-600 uppercase tracking-wider">Proctor & Admin</span>
                <h4 className="mt-1 font-bold text-slate-900 text-sm">Monitoring & Management</h4>
              </div>
              <span className="mt-4 text-xs text-slate-500">Monitor (Port 3002) / Admin (Port 3000)</span>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}