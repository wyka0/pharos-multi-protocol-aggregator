'use client';

import type { PortfolioQueryResult } from '@/lib/types';
import { formatBps, formatUsdc } from '@/lib/format';

export function PortfolioCard({ portfolio, loading }: { portfolio: PortfolioQueryResult | null; loading: boolean }) {
  return (
    <section className="harbor-panel p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold tracking-wide text-cyan-300">UNIFIED PORTFOLIO (all healthy protocols)</h2>
        {loading && <span className="harbor-badge animate-pulse">syncing</span>}
      </div>

      {!portfolio ? (
        <p className="text-xs text-slate-500">Run a query, e.g. "Show my positions and current APY across all vaults".</p>
      ) : (
        <>
          <div className="mb-4 grid grid-cols-3 gap-3">
            <Stat label="Total value" value={`$${formatUsdc(portfolio.totals.underlyingValue)}`} />
            <Stat label="Accrued yield" value={`+$${formatUsdc(portfolio.totals.accruedYield)}`} accent />
            <Stat label="Weighted net APY" value={formatBps(portfolio.weightedNetApyBps)} />
          </div>

          {portfolio.positions.length === 0 ? (
            <p className="text-xs text-slate-500">No open positions in healthy vaults.</p>
          ) : (
            <div className="harbor-scroll overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-cyan-300/70">
                  <tr>
                    <th className="pb-2 pr-3 font-medium">Vault</th>
                    <th className="pb-2 pr-3 font-medium">Underlying</th>
                    <th className="pb-2 pr-3 font-medium">Principal</th>
                    <th className="pb-2 pr-3 font-medium">Accrued</th>
                    <th className="pb-2 pr-3 font-medium">Net APY</th>
                    <th className="pb-2 font-medium">Max withdrawable</th>
                  </tr>
                </thead>
                <tbody className="font-mono text-slate-300">
                  {portfolio.positions.map((p) => (
                    <tr key={p.protocolId} className="border-t border-cyan-500/10">
                      <td className="py-1.5 pr-3">{p.label}</td>
                      <td className="py-1.5 pr-3">${formatUsdc(p.underlyingValue)}</td>
                      <td className="py-1.5 pr-3">${formatUsdc(p.principalDeposited)}</td>
                      <td className="py-1.5 pr-3 text-emerald-300">+${formatUsdc(p.accruedYield)}</td>
                      <td className="py-1.5 pr-3">{formatBps(p.netApyBps)}</td>
                      <td className="py-1.5">${formatUsdc(p.maxWithdrawable)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-lg border border-cyan-500/15 bg-cyan-500/5 p-3">
      <div className="text-[10px] uppercase tracking-wider text-slate-400">{label}</div>
      <div className={`mt-1 font-mono text-lg ${accent ? 'text-emerald-300' : 'text-cyan-100'}`}>{value}</div>
    </div>
  );
}
