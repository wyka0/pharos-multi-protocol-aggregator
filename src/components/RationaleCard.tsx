'use client';

import type { RoutingRationale } from '@/lib/types';
import { formatBps, formatUsdc } from '@/lib/format';

export function RationaleCard({ rationale }: { rationale: RoutingRationale | null }) {
  if (!rationale) return null;

  return (
    <section className="harbor-panel p-5">
      <h2 className="mb-3 text-sm font-semibold tracking-wide text-cyan-300">
        WHY THIS VENUE WON - {rationale.action.toUpperCase()} ROUTING RATIONALE
      </h2>

      {rationale.degradedMode && (
        <div className="mb-3 rounded-lg border border-amber-400/40 bg-amber-400/10 p-3 text-xs text-amber-200">
          {rationale.degradedNotes.length > 0
            ? rationale.degradedNotes.map((n, i) => <div key={i}>{n}</div>)
            : 'DEGRADED MODE: one or more protocols were excluded from routing.'}
        </div>
      )}

      <div className="mb-4 rounded-lg border border-cyan-500/25 bg-cyan-500/5 p-3 text-xs leading-relaxed text-cyan-100">
        {rationale.summary}
      </div>

      <div className="harbor-scroll overflow-x-auto">
        <table className="w-full text-left text-[11px]">
          <thead className="text-cyan-300/70">
            <tr>
              <th className="pb-1.5 pr-3 font-medium">Venue</th>
              <th className="pb-1.5 pr-3 font-medium">Headline</th>
              <th className="pb-1.5 pr-3 font-medium">Post-action</th>
              <th className="pb-1.5 pr-3 font-medium">Entry fee</th>
              <th className="pb-1.5 pr-3 font-medium">Gross</th>
              <th className="pb-1.5 pr-3 font-medium">Net ({rationale.horizonDays}d)</th>
              <th className="pb-1.5 font-medium">Verdict</th>
            </tr>
          </thead>
          <tbody className="font-mono text-slate-300">
            {rationale.comparisonTable.map((c) => (
              <tr key={c.protocolId} className={`border-t border-cyan-500/10 ${c.selected ? 'bg-cyan-500/10' : ''} ${!c.healthy ? 'opacity-40' : ''}`}>
                <td className="py-1.5 pr-3">
                  {c.selected ? '★ ' : ''}
                  {c.label}
                </td>
                <td className="py-1.5 pr-3">{formatBps(c.headlineApyBps)}</td>
                <td className="py-1.5 pr-3">{formatBps(c.postDepositApyBps)}</td>
                <td className="py-1.5 pr-3">
                  {c.entryFeeBps} bps (${formatUsdc(c.entryFeeCost)})
                </td>
                <td className="py-1.5 pr-3">${formatUsdc(c.grossYield)}</td>
                <td className={`py-1.5 pr-3 ${c.netExpectedYield >= 0n ? 'text-emerald-300' : 'text-rose-300'}`}>
                  {c.netExpectedYield >= 0n ? '+' : '-'}${formatUsdc(c.netExpectedYield < 0n ? -c.netExpectedYield : c.netExpectedYield)}
                </td>
                <td className="py-1.5 text-[10px] text-slate-400">{c.selected ? 'SELECTED' : c.rejectionReasons.join('; ') || 'runner-up'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
