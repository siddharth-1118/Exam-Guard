'use client';

/**
 * LiveMediaPanel — real monitor media view (Phase 4C.2).
 *
 * Subscribes the CURRENT focused student's camera / screen / microphone
 * through the SFU using the shared MonitorSubscriber (consumer only — never
 * getUserMedia). Audio is MUTED by default and resets on student switch; the
 * monitor can explicitly enable the focused student's audio only.
 *
 * Attempt end / publisher loss is server-driven: the SFU closes the subscriber
 * socket (4002) and token issuance stops, so the panel stops cleanly and never
 * reconnects into the void (bounded reconnects only for transient drops).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  MonitorSubscriber,
  type FeedState,
  type SubscriberState,
  type SubscriberTokenInfo,
  type TrackKind,
} from '@/lib/media/subscriber';
import { gate } from '@/lib/gate';

/** Attempt states that can carry a live publisher session worth watching. */
const WATCHABLE = new Set(['ACTIVE', 'PAUSED', 'DISCONNECTED']);
const TERMINAL = new Set(['SUBMITTED', 'AUTO_SUBMITTED', 'TERMINATED', 'UNDER_REVIEW']);

interface StatusView {
  tone: string;
  label: string;
}

function statusView(state: SubscriberState): StatusView {
  switch (state) {
    case 'subscribed':
      return { tone: 'bg-emerald-500/15 text-emerald-300 border-emerald-800', label: '● live' };
    case 'reconnecting':
      return { tone: 'bg-amber-500/10 text-amber-300 border-amber-800', label: 'reconnecting…' };
    case 'connecting':
      return { tone: 'bg-amber-500/10 text-amber-300 border-amber-800', label: 'connecting…' };
    case 'failed':
      return { tone: 'bg-red-500/10 text-red-300 border-red-900', label: 'failed' };
    case 'stopped':
      return { tone: 'bg-slate-800 text-slate-400 border-slate-700', label: 'disconnected' };
    default:
      return { tone: 'bg-slate-800 text-slate-500 border-slate-800', label: 'idle' };
  }
}

/** Short, human-readable explanation for a closed subscription. */
function closeReason(code: number): string {
  if (code === 4002) return 'the student session ended';
  if (code === 1000 || code === 1005) return 'connection closed';
  if (code === 1006) return 'network connection lost';
  return `server closed the connection (${code})`;
}

export function LiveMediaPanel({
  attemptId,
  attemptStatus,
}: {
  attemptId: string | null;
  attemptStatus: string;
}) {
  const subscriberRef = useRef<MonitorSubscriber | null>(null);
  const [state, setState] = useState<SubscriberState>('idle');
  const [feeds, setFeeds] = useState<FeedState[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [audioEnabled, setAudioEnabled] = useState(false); // MUTED BY DEFAULT
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const ended = TERMINAL.has(attemptStatus);
  const watchable = Boolean(attemptId) && WATCHABLE.has(attemptStatus);

  useEffect(() => {
    // A different focused student always starts muted again.
    setAudioEnabled(false);
    setMessage(null);
    setState('idle');
    setFeeds([]);
    if (!attemptId || !WATCHABLE.has(attemptStatus)) return undefined;
    const sub = new MonitorSubscriber({
      attemptId,
      getToken: async () =>
        gate<SubscriberTokenInfo>('/media/subscriber-token', 'POST', { attemptId }),
      onState: (next, feedsNow) => {
        setState(next);
        setFeeds(feedsNow);
        if (next === 'subscribed') setMessage(null);
      },
      onClose: (info) => {
        if (info.code === 4002) {
          setState('stopped');
          setMessage('the student session ended');
        } else if (info.code === 0 || info.code === 401 || info.code === 403 || info.code === 404) {
          // Token/authorization refusal (e.g. the student never started the
          // secure desktop, or access was revoked) — a settled state, not a
          // retry loop.
          setState('stopped');
          setMessage('live feed unavailable for this student');
        }
      },
      log: (line) => {
        // Technical detail for development consoles only — never shown raw.
        if (process.env.NODE_ENV !== 'production') console.debug('[sub]', line);
      },
    });
    subscriberRef.current = sub;
    void sub.start().catch((err) => {
      setMessage(err instanceof Error ? err.message : 'Subscription failed');
      setState('stopped');
    });
    return () => {
      subscriberRef.current = null;
      sub.stop();
    };
  }, [attemptId, attemptStatus]);

  // Keep the (hidden) audio element bound to the current microphone track,
  // muted until the monitor explicitly enables it for the focused student.
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const track = subscriberRef.current?.trackOf('microphone') ?? null;
    if (track) {
      el.srcObject = new MediaStream([track]);
      el.muted = !audioEnabled;
      void el.play().catch(() => undefined);
    } else {
      el.srcObject = null;
    }
  }, [state, feeds, audioEnabled]);

  const isLive = useCallback(
    (kind: TrackKind): boolean => feeds.find((f) => f.kind === kind)?.status === 'live',
    [feeds],
  );

  const view = statusView(state);

  // No attempt to watch at all.
  if (!attemptId) {
    return (
      <div className="rounded-lg border border-slate-800 bg-slate-950 p-6 text-center text-sm text-slate-500">
        {attemptStatus === 'NOT_STARTED'
          ? 'This student has not started an exam attempt — nothing to monitor live.'
          : 'No active media session for this student.'}
      </div>
    );
  }

  // Attempt ended (submitted/terminated) — the live view is over, server-side.
  if (ended) {
    return (
      <div className="rounded-lg border border-amber-900/50 bg-amber-950/20 p-6 text-center text-sm text-amber-200/80">
        Attempt {attemptStatus.replace('_', ' ').toLowerCase()} — the live feed has ended.
      </div>
    );
  }

  const tiles: TrackKind[] = ['camera', 'screen', 'microphone'];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span
          className={`rounded-full border px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${view.tone}`}
        >
          {view.label}
        </span>
        {message ? (
          <span className="text-[10px] text-amber-300/90">{message}</span>
        ) : state === 'reconnecting' ? (
          <span className="text-[10px] text-amber-300/90">brief interruption — reconnecting…</span>
        ) : null}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {tiles.map((kind) => (
          <div
            key={kind}
            className="overflow-hidden rounded-lg border border-slate-800 bg-slate-950"
            data-tile={kind}
          >
            <div className="flex items-center justify-between border-b border-slate-800 px-3 py-1.5">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                {kind === 'camera' ? 'live camera' : kind === 'screen' ? 'screen' : 'live audio'}
              </p>
              <span
                className={`h-1.5 w-1.5 rounded-full ${isLive(kind) ? 'bg-emerald-400' : 'bg-slate-600'}`}
                title={isLive(kind) ? 'live' : 'unavailable'}
              />
            </div>
            {kind === 'microphone' ? (
              <div className="flex aspect-video flex-col items-center justify-center gap-3 px-3">
                <audio ref={audioRef} autoPlay playsInline muted className="hidden" data-kind="microphone" />
                <div className="w-full">
                  {isLive(kind) ? (
                    <button
                      type="button"
                      onClick={() => {
                        const next = !audioEnabled;
                        setAudioEnabled(next);
                        if (audioRef.current) {
                          audioRef.current.muted = !next;
                          void audioRef.current.play().catch(() => undefined);
                        }
                      }}
                      className={`w-full rounded-md border px-2 py-1.5 text-[11px] font-medium transition-colors ${
                        audioEnabled
                          ? 'border-red-700 bg-red-600/20 text-red-300 hover:bg-red-600/30'
                          : 'border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800'
                      }`}
                    >
                      {audioEnabled ? '🔊 Mute audio' : '🔇 Enable audio (focused student only)'}
                    </button>
                  ) : (
                    <p className="text-center text-[10px] text-slate-600">
                      {state === 'subscribed' ? 'no microphone feed from this student' : 'waiting for microphone feed…'}
                    </p>
                  )}
                </div>
                <p className="text-[9px] text-slate-600">muted by default</p>
              </div>
            ) : (
              <FeedVideo kind={kind} subscriber={subscriberRef} live={isLive(kind)} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Binds the subscriber's current MediaStreamTrack for one kind to a <video>.
 *
 * The student publisher may legitimately reconnect mid-exam: the SFU room is
 * replaced and the subscriber re-creates consumers/tracks with NEW identities.
 * A single bind on mount would freeze on the ended track, so the track identity
 * is polled and re-attached whenever it changes (the same mechanism the E2E
 * driver uses). Never drives a second capture — the monitor is subscriber-only.
 */
function FeedVideo({
  kind,
  subscriber,
  live,
}: {
  kind: TrackKind;
  subscriber: React.RefObject<MonitorSubscriber | null>;
  live: boolean;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const attachedId = useRef<string | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const bind = (): void => {
      const track = subscriber.current?.trackOf(kind) ?? null;
      const id = track?.id ?? null;
      if (id === attachedId.current) return;
      attachedId.current = id;
      if (track) {
        el.srcObject = new MediaStream([track]);
        el.muted = true; // video elements never carry audio
        void el.play().catch(() => undefined);
      } else {
        el.srcObject = null;
      }
    };
    bind();
    // Transient publisher reconnects recreate tracks — pick the new identity up.
    const timer = window.setInterval(bind, 300);
    return () => {
      window.clearInterval(timer);
      el.srcObject = null;
    };
  }, [subscriber, kind, live]);

  return (
    <div className="relative flex aspect-video items-center justify-center bg-slate-950">
      <video ref={ref} autoPlay playsInline muted className="h-full w-full object-contain" data-kind={kind} />
      {!live && (
        <p className="absolute inset-x-0 bottom-0 bg-slate-950/80 px-2 py-1 text-center text-[10px] text-amber-300/90">
          feed unavailable
        </p>
      )}
    </div>
  );
}
