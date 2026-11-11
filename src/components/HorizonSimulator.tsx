'use client';

import { useMemo, useState } from 'react';
import type { VenueHealthEntry, VenueSnapshot } from '@/lib/types';
import { DEFAULT_GAS_POLICY, buildDepositRationale, evaluateDepositCandidates } from '@/lib/router';
import { harborPostDepositApyBps } from '@/lib/adapters/harbor-lend';
import { primePostDepositApyBps } from '@/lib/adapters/atlantic-prime';
import { rwaPostDepositApyBps } from '@/lib/adapters/pharos-rwa';
import { formatBps, formatUsdc, toUnits6 } from '@/lib/format';

/* Lightweight client-side preview adapters: the same pure utilization models
   the server router uses, fed by live /api/venues snapshots. This powers the
   real-time venue-switching sliders WITHOUT any server round-trip. */
function previewAdapterFor(s: VenueSnapshot) {
  const model = s.model;
  return {
    protocolId: s.protocolId,
    label: s.label,
    archetype: s.archetype,
    vaultAddress: s.vaultAddress,
    simulatePostDepositApy: (_snap: VenueSnapshot, dx: bigint): number => {
      if (s.protocolId === 'HARBOR_LEND') return harborPostDepositApyBps(model, dx);
      if (s.protocolId === 'ATLANTIC_PRIME') return primePostDepositApyBps(model, dx);
      return rwaPostDepositApyBps();
    },
  };
}

export function HorizonSimulator({ venues, health }: { venues: VenueSnapshot[]; health: VenueHealthEntry[] }) {
  const [amount, setAmount] = useState(500);
  const [horizon, setHorizon] = useState(30);

  const evaluation = useMemo(() => {
    if (venues.length === 0) return null;
    const adapters = venues.map(previewAdapterFor);
    const candidates = evaluateDepositCandidates({
      snapshots: venues,
      health,
      adapters,
      amount: toUnits6(amount),
      horizonDays: horizon,
      gasPolicy: DEFAULT_GAS_POLICY,
    });
    return buildDepositRationale({
      candidates,
      amount: toUnits6(amount),
      horizonDays: horizon,
      venueHealth: health,
      degradedNotes: [],
    });
  }, [venues, health, amount, horizon]);

  return (
    <section className="harbor-panel p-5">
      <h2 className="mb-1 text-sm font-semibold tracking-wide text-cyan-300">HORIZON-AWARE NET-YIELD OPTIMIZER (live)</h2>
      <p className="mb-4 text-[11px] text-slate-500">
        Drag the sliders and watch the router flip venues: entry fees cannot amortize over short horizons, and whale deposits
        dilute utilization curves. Real-time preview uses the same pure routing math as the server.
      </p>

      <div className="grid gap-4 md:grid-cols-2">
        <Slider label="Deposit amount" value={amount} min={100} max={100000} step={100} onChange={setAmount} display={`$${amount.toLocaleString()} USDC`} />
        <Slider label="Holding horizon" value={horizon} min={1} max={365} step={1} onChange={setHorizon} display={`${horizon} days`} />
      </div>

      {evaluation && (
        <div className="mt-4">
          <div className="mb-2 rounded-lg border border-cyan-500/25 bg-cyan-500/5 p-3 text-xs leading-relaxed text-cyan-100">
            {evaluation.summary}
          </div>
          <div className="harbor-scroll overflow-x-auto">
            <table className="w-full text-left text-[11px]">
              <thead className="text-cyan-300/70">
                <tr>
                  <th className="pb-1.5 pr-3 font-medium">Venue</th>
                  <th className="pb-1.5 pr-3 font-medium">Post-dx APY</th>
                  <th className="pb-1.5 pr-3 font-medium">Entry fee</th>
                  <th className="pb-1.5 pr-3 font-medium">Net {horizon}d</th>
                  <th className="pb-1.5 font-medium">Eff. net APY</th>
                </tr>
              </thead>
              <tbody className="font-mono text-slate-300">
                {evaluation.comparisonTable.map((c) => (
                  <tr key={c.protocolId} className={`border-t border-cyan-500/10 ${c.selected ? 'bg-cyan-500/10' : ''} ${!c.healthy ? 'opacity-40' : ''}`}>
                    <td className="py-1.5 pr-3">
                      {c.selected ? '★ ' : ''}
                      {c.label}
                    </td>
                    <td className="py-1.5 pr-3">{formatBps(c.postDepositApyBps)}</td>
                    <td className="py-1.5 pr-3">
                      {c.entryFeeBps} bps (${formatUsdc(c.entryFeeCost)})
                    </td>
                    <td className={`py-1.5 pr-3 ${c.netExpectedYield >= 0n ? 'text-emerald-300' : 'text-rose-300'}`}>
                      {c.netExpectedYield >= 0n ? '+' : '-'}${formatUsdc(c.netExpectedYield < 0n ? -c.netExpectedYield : c.netExpectedYield)}
                    </td>
                    <td className="py-1.5">{formatBps(c.effectiveNetApyBps)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

function Slider({ label, value, min, max, step, onChange, display }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; display: string }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="text-slate-400">{label}</span>
        <span className="font-mono text-cyan-200">{display}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full" />
    </div>
  );
}
