'use client';

import type { VenueHealthEntry, VenueSnapshot } from '@/lib/types';
import { formatBps, formatUsdc, formatWad } from '@/lib/format';

export function RateMatrix({ venues, health }: { venues: VenueSnapshot[]; health: VenueHealthEntry[] }) {
  return (
    <section className="harbor-panel p-5">
      <h2 className="mb-3 text-sm font-semibold tracking-wide text-cyan-300">3-VAULT RATE MATRIX (live on-chain)</h2>
      {venues.length === 0 ? (
        <p className="text-xs text-slate-500">No venue data - deploy the suite (`npm run deploy`) and refresh.</p>
      ) : (
        <div className="harbor-scroll overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-cyan-300/70">
              <tr>
                <th className="pb-2 pr-3 font-medium">Protocol</th>
                <th className="pb-2 pr-3 font-medium">Spot APY</th>
                <th className="pb-2 pr-3 font-medium">Fees (in/out)</th>
                <th className="pb-2 pr-3 font-medium">TVL</th>
                <th className="pb-2 pr-3 font-medium">Liquidity</th>
                <th className="pb-2 pr-3 font-medium">Utilization</th>
                <th className="pb-2 font-medium">Health</th>
              </tr>
            </thead>
            <tbody className="font-mono text-slate-300">
              {venues.map((v) => {
                const h = health.find((x) => x.protocolId === v.protocolId);
                const state = v.paused ? 'CIRCUIT_OPEN_PAUSED' : (h?.state ?? 'HEALTHY');
                return (
                  <tr key={v.protocolId} className="border-t border-cyan-500/10">
                    <td className="py-1.5 pr-3">
                      <div className="text-slate-200">{v.label}</div>
                      <div className="text-[10px] text-slate-500">{v.archetype}</div>
                    </td>
                    <td className="py-1.5 pr-3 text-cyan-200">{formatBps(v.spotApyBps)}</td>
                    <td className="py-1.5 pr-3">
                      {v.entryFeeBps} / {v.exitFeeBps} bps
                    </td>
                    <td className="py-1.5 pr-3">${formatUsdc(v.totalTvl, 0)}</td>
                    <td className="py-1.5 pr-3">${formatUsdc(v.availableLiquidity, 0)}</td>
                    <td className="py-1.5 pr-3">{formatWad(v.utilizationWad, 1)}</td>
                    <td className="py-1.5">
                      <HealthBadge state={state} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function HealthBadge({ state }: { state: string }) {
  const styles: Record<string, string> = {
    HEALTHY: 'border-emerald-400/40 bg-emerald-400/10 text-emerald-300',
    DEGRADED_TIMEOUT: 'border-amber-400/40 bg-amber-400/10 text-amber-300',
    RPC_REVERT: 'border-orange-400/40 bg-orange-400/10 text-orange-300',
    RPC_ERROR: 'border-orange-400/40 bg-orange-400/10 text-orange-300',
    CIRCUIT_OPEN: 'border-rose-400/40 bg-rose-400/10 text-rose-300',
    CIRCUIT_OPEN_PAUSED: 'border-rose-400/40 bg-rose-400/10 text-rose-300',
  };
  const label = state === 'CIRCUIT_OPEN_PAUSED' ? 'PAUSED' : state === 'CIRCUIT_OPEN' ? 'CIRCUIT OPEN' : state;
  return (
    <span className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-wide ${styles[state] ?? 'border-slate-500/40 text-slate-400'}`}>
      {label}
    </span>
  );
}
