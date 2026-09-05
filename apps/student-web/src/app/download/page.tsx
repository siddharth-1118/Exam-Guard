'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';

export default function DownloadPage() {
  const version = '0.3.0';
  const releaseDate = 'September 5, 2026';
  const sha256 = 'be7a76f8b0fe51e32b7832700cdb5a77db3c15d0442db4ef5302fde1acc7f89d';

  const [detectedOS, setDetectedOS] = useState<'windows' | 'mac' | 'linux' | 'unknown'>('unknown');

  useEffect(() => {
    const userAgent = window.navigator.userAgent.toLowerCase();
    if (userAgent.includes('win')) {
      setDetectedOS('windows');
    } else if (userAgent.includes('mac')) {
      setDetectedOS('mac');
    } else if (userAgent.includes('linux')) {
      setDetectedOS('linux');
    }
  }, []);

  const steps = [
    { num: 1, title: 'Download Application', desc: 'Download the official ExamGuard installer for your operating system (Windows, macOS, or Linux).' },
    { num: 2, title: 'Install ExamGuard', desc: 'Run the setup installer on your machine and follow the prompt.' },
    { num: 3, title: 'Sign In', desc: 'Launch ExamGuard and log in using your institutional student credentials.' },
    { num: 4, title: 'Select Scheduled Exam', desc: 'Choose your assigned examination from the active schedule list.' },
    { num: 5, title: 'Run System Checks', desc: 'Perform automated preflight verification for camera, mic, screen, and network latency.' },
    { num: 6, title: 'Wait for Scheduled Start', desc: 'Remain in the preflight screen until the server authorizes the official start time.' },
    { num: 7, title: 'Enter Secure Exam State', desc: 'ExamGuard activates kiosk lockdown, focus protection, and shortcut interception.' },
    { num: 8, title: 'Proctoring Streams Active', desc: 'Webcam, microphone, and screen monitoring channels securely connect to the SFU.' },
    { num: 9, title: 'Live Proctor Observation', desc: 'Authorized proctors and advisory AI monitor the session for integrity compliance.' },
    { num: 10, title: 'Submit Exam', desc: 'Complete your answers and submit the exam prior to the authoritative server deadline.' },
    { num: 11, title: 'Clean Exit', desc: 'Media streams disconnect cleanly and ExamGuard safely restores standard desktop state.' },
  ];

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
            <Link href="/" className="text-slate-600 hover:text-slate-900">Home</Link>
            <Link href="/login" className="text-slate-600 hover:text-slate-900">Student Sign In</Link>
            <Link href="/download" className="rounded-lg bg-indigo-600 px-3.5 py-2 text-white hover:bg-indigo-700">Download App</Link>
          </div>
        </div>
      </header>

      {/* Main Download Hero */}
      <main className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
        <div className="text-center">
          <span className="inline-block rounded-full bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-700 ring-1 ring-inset ring-indigo-700/10">
            Latest Stable Release: v{version}
          </span>
          <h1 className="mt-4 text-3xl font-extrabold tracking-tight text-slate-900 sm:text-5xl">
            Download ExamGuard Desktop
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-base text-slate-600 sm:text-lg">
            High-integrity examination client for Windows, macOS, and Linux. Features hardware preflight checks, encrypted proctoring, and context lockdown.
          </p>

          {detectedOS !== 'unknown' && (
            <div className="mt-4 inline-flex items-center gap-2 rounded-full bg-emerald-50 px-4 py-1.5 text-xs font-medium text-emerald-800 ring-1 ring-inset ring-emerald-600/20">
              <span className="flex h-2 w-2 rounded-full bg-emerald-500 animate-pulse"></span>
              Detected Operating System: <span className="font-bold capitalize">{detectedOS === 'mac' ? 'macOS' : detectedOS}</span>
            </div>
          )}
        </div>

        {/* Platform Cards Grid */}
        <div className="mt-12 grid grid-cols-1 gap-6 md:grid-cols-3">
          {/* Windows Card */}
          <div className={`flex flex-col justify-between rounded-2xl border bg-white p-6 shadow-sm ring-1 transition ${
            detectedOS === 'windows' ? 'border-indigo-600 ring-indigo-600/30 shadow-md bg-indigo-50/10' : 'border-slate-200 ring-slate-900/5 hover:shadow-md'
          }`}>
            <div>
              <div className="flex items-center justify-between">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
                  <svg className="h-6 w-6" fill="currentColor" viewBox="0 0 24 24"><path d="M0 3.449L9.75 2.1v9.451H0m10.95-9.6L24 0v11.4H10.95M0 12.6h9.75v9.451L0 20.699M10.95 12.6H24V24l-13.05-1.8" /></svg>
                </div>
                {detectedOS === 'windows' ? (
                  <span className="rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-semibold text-white">Your System</span>
                ) : (
                  <span className="rounded-md bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-600/20">Windows 10 / 11</span>
                )}
              </div>
              <h3 className="mt-4 text-xl font-bold text-slate-900">Windows</h3>
              <p className="mt-1 text-xs text-slate-500">Windows 10 / 11 (64-bit)</p>
              <div className="mt-4 space-y-1.5 text-xs text-slate-600">
                <p><span className="font-semibold">Installer:</span> ExamGuard-Setup-{version}.exe</p>
                <p><span className="font-semibold">Format:</span> Windows Executable (.exe)</p>
                <p><span className="font-semibold">Release Date:</span> {releaseDate}</p>
              </div>
            </div>
            <div className="mt-6">
              <a
                href={`https://github.com/siddharth-1118/Exam-Guard/releases/download/v${version}/ExamGuard-Setup-${version}.exe`}
                className="block w-full rounded-xl bg-indigo-600 py-3 text-center text-sm font-semibold text-white shadow hover:bg-indigo-700"
              >
                Download for Windows (.exe)
              </a>
            </div>
          </div>

          {/* macOS Card */}
          <div className={`flex flex-col justify-between rounded-2xl border bg-white p-6 shadow-sm ring-1 transition ${
            detectedOS === 'mac' ? 'border-indigo-600 ring-indigo-600/30 shadow-md bg-indigo-50/10' : 'border-slate-200 ring-slate-900/5 hover:shadow-md'
          }`}>
            <div>
              <div className="flex items-center justify-between">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-slate-100 text-slate-700">
                  <svg className="h-6 w-6" fill="currentColor" viewBox="0 0 24 24"><path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M15.97 6.63c.67-.82 1.13-1.96.99-3.13-.98.04-2.19.66-2.88 1.47-.62.72-1.16 1.88-.99 3.03 1.09.08 2.22-.55 2.88-1.37z" /></svg>
                </div>
                {detectedOS === 'mac' ? (
                  <span className="rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-semibold text-white">Your System</span>
                ) : (
                  <span className="rounded-md bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-600/20">macOS 12+</span>
                )}
              </div>
              <h3 className="mt-4 text-xl font-bold text-slate-900">macOS</h3>
              <p className="mt-1 text-xs text-slate-500">Universal (Intel & Apple Silicon M1/M2/M3/M4)</p>
              <div className="mt-4 space-y-1.5 text-xs text-slate-600">
                <p><span className="font-semibold">Installer:</span> ExamGuard-{version}.dmg</p>
                <p><span className="font-semibold">Format:</span> Apple Disk Image (.dmg)</p>
                <p><span className="font-semibold">Release Date:</span> {releaseDate}</p>
              </div>
            </div>
            <div className="mt-6">
              <a
                href={`https://github.com/siddharth-1118/Exam-Guard/releases/download/v${version}/ExamGuard-${version}.dmg`}
                className="block w-full rounded-xl bg-slate-900 py-3 text-center text-sm font-semibold text-white shadow hover:bg-slate-800"
              >
                Download for macOS (.dmg)
              </a>
            </div>
          </div>

          {/* Linux Card */}
          <div className={`flex flex-col justify-between rounded-2xl border bg-white p-6 shadow-sm ring-1 transition ${
            detectedOS === 'linux' ? 'border-indigo-600 ring-indigo-600/30 shadow-md bg-indigo-50/10' : 'border-slate-200 ring-slate-900/5 hover:shadow-md'
          }`}>
            <div>
              <div className="flex items-center justify-between">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-orange-50 text-orange-600">
                  <svg className="h-6 w-6" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z" /></svg>
                </div>
                {detectedOS === 'linux' ? (
                  <span className="rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-semibold text-white">Your System</span>
                ) : (
                  <span className="rounded-md bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-600/20">Ubuntu / Debian / Fedora</span>
                )}
              </div>
              <h3 className="mt-4 text-xl font-bold text-slate-900">Linux</h3>
              <p className="mt-1 text-xs text-slate-500">Ubuntu 20.04+, Debian 11+, Fedora 36+</p>
              <div className="mt-4 space-y-1.5 text-xs text-slate-600">
                <p><span className="font-semibold">Package:</span> ExamGuard-{version}.AppImage</p>
                <p><span className="font-semibold">Format:</span> Portable Linux Package (.AppImage)</p>
                <p><span className="font-semibold">Release Date:</span> {releaseDate}</p>
              </div>
            </div>
            <div className="mt-6">
              <a
                href={`https://github.com/siddharth-1118/Exam-Guard/releases/download/v${version}/ExamGuard-${version}.AppImage`}
                className="block w-full rounded-xl bg-slate-900 py-3 text-center text-sm font-semibold text-white shadow hover:bg-slate-800"
              >
                Download for Linux (.AppImage)
              </a>
            </div>
          </div>
        </div>

        {/* SHA-256 Verification Section */}
        <div className="mt-8 rounded-xl border border-slate-200 bg-white p-4">
          <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500">Official Binary SHA-256 Checksum</h4>
          <code className="mt-1 block overflow-x-auto rounded-lg bg-slate-900 p-2.5 text-xs font-mono text-emerald-400">
            {sha256}
          </code>
        </div>

        {/* How ExamGuard Works Section */}
        <div className="mt-16">
          <h2 className="text-2xl font-bold text-slate-900 sm:text-3xl text-center">How ExamGuard Works</h2>
          <p className="mt-2 text-center text-sm text-slate-600">End-to-end examination lifecycle from student login to automated submission.</p>

          <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {steps.map((step) => (
              <div key={step.num} className="rounded-xl border border-slate-200 bg-white p-5 shadow-xs">
                <div className="flex items-center gap-3">
                  <span className="flex h-7 w-7 items-center justify-center rounded-full bg-indigo-600 text-xs font-bold text-white">
                    {step.num}
                  </span>
                  <h3 className="font-semibold text-slate-900 text-sm">{step.title}</h3>
                </div>
                <p className="mt-2.5 text-xs leading-relaxed text-slate-600">{step.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
