'use client';

import { useState } from 'react';
import { PROTOCOL_LABELS, PROTOCOL_IDS, type ProtocolId } from '@/lib/types';

/* Live Protocol Chaos/Outage toggle: reviewers can kill any protocol and
   watch the other two keep serving queries + routing (Requirement 04 demo). */

export function ChaosPanel({ onChange, forcedOutages }: { onChange: () => void; forcedOutages: ProtocolId[] }) {
  const [busy, setBusy] = useState<string | null>(null);

  const toggle = async (protocolId: ProtocolId, kill: boolean) => {
    setBusy(protocolId);
    try {
      await fetch('/api/chaos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(kill ? { protocolId, kind: 'TIMEOUT' } : { protocolId, clear: true }),
      });
      onChange();
    } finally {
      setBusy(null);
    }
  };

  const clearAll = async () => {
    setBusy('ALL');
    try {
      await fetch('/api/chaos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clear: true }),
      });
      onChange();
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="harbor-panel p-5">
      <h2 className="mb-1 text-sm font-semibold tracking-wide text-rose-300">PROTOCOL CHAOS / OUTAGE TOGGLE</h2>
      <p className="mb-3 text-[11px] text-slate-500">
        Kill any protocol; the resilient mesh keeps serving the remaining healthy venues via Promise.allSettled + per-protocol
        circuit breakers. (On-chain pause drills: `pauseProtocol` in scripts/verify-onchain.ts.)
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {PROTOCOL_IDS.map((p) => {
          const killed = forcedOutages.includes(p);
          return (
            <button
              key={p}
              disabled={busy === p}
              onClick={() => toggle(p, !killed)}
              className={`rounded-lg border px-3 py-1.5 text-[11px] font-semibold transition ${
                killed
                  ? 'border-rose-400/60 bg-rose-500/15 text-rose-200'
                  : 'border-emerald-400/40 bg-emerald-400/10 text-emerald-200 hover:border-emerald-300/60'
              }`}
            >
              {killed ? '✕ ' : '● '}
              {PROTOCOL_LABELS[p]}
              <span className="ml-1 opacity-70">{killed ? '(killed)' : '(live)'}</span>
            </button>
          );
        })}
        <button className="harbor-btn px-3 py-1.5 text-[11px]" disabled={busy !== null} onClick={clearAll}>
          Restore all
        </button>
      </div>
    </section>
  );
}
