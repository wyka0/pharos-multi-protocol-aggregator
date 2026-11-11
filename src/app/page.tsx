'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAccount } from 'wagmi';
import type { AgentResponse, PortfolioQueryResult, ProtocolId, VenueSnapshot, VenueHealthEntry } from '@/lib/types';
import { PHAROS_CHAIN_ID } from '@/lib/types';
import { WalletBar } from '@/components/WalletBar';
import { PortfolioCard } from '@/components/PortfolioCard';
import { RateMatrix } from '@/components/RateMatrix';
import { CommandBar } from '@/components/CommandBar';
import { HorizonSimulator } from '@/components/HorizonSimulator';
import { RationaleCard } from '@/components/RationaleCard';
import { PayloadInspector } from '@/components/PayloadInspector';
import { ChaosPanel } from '@/components/ChaosPanel';

interface VenuesResponse {
  configured: boolean;
  configError?: string;
  venues: VenueSnapshot[];
  health: VenueHealthEntry[];
  allHealth?: VenueHealthEntry[];
}

export default function HarborConsole() {
  const { address } = useAccount();
  const [venues, setVenues] = useState<VenueSnapshot[]>([]);
  const [health, setHealth] = useState<VenueHealthEntry[]>([]);
  const [forcedOutages, setForcedOutages] = useState<ProtocolId[]>([]);
  const [configError, setConfigError] = useState<string | null>(null);
  const [response, setResponse] = useState<AgentResponse | null>(null);
  const [running, setRunning] = useState(false);
  const [venuesLoading, setVenuesLoading] = useState(true);

  const refreshVenues = useCallback(async () => {
    try {
      const res = await fetch('/api/venues');
      const data: VenuesResponse = await res.json();
      setVenues(data.venues ?? []);
      setHealth(data.allHealth ?? data.health ?? []);
      setConfigError(data.configError ?? null);
    } catch {
      setConfigError('Failed to reach /api/venues - is the dev server up?');
    } finally {
      setVenuesLoading(false);
    }
  }, []);

  const refreshChaos = useCallback(async () => {
    try {
      const res = await fetch('/api/chaos');
      const data = await res.json();
      setForcedOutages((data.forced ?? []).map((f: { protocolId: ProtocolId }) => f.protocolId));
    } catch {
      /* chaos panel is best-effort */
    }
  }, []);

  useEffect(() => {
    void refreshVenues();
    void refreshChaos();
    const t = setInterval(() => void refreshVenues(), 20_000);
    return () => clearInterval(t);
  }, [refreshVenues, refreshChaos]);

  const runCommand = useCallback(
    async (input: string) => {
      setRunning(true);
      try {
        const res = await fetch('/api/agent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ input, user: address }),
        });
        const data: AgentResponse = await res.json();
        setResponse(data);
        void refreshVenues();
        void refreshChaos();
      } catch (e) {
        setResponse({
          ok: false,
          intent: { kind: 'unknown', raw: input, confidence: 0, matched: [], hint: 'network error' },
          mode: 'query',
          venueHealth: [],
          degradedMode: true,
          error: e instanceof Error ? e.message : String(e),
          parsedAt: Date.now(),
        });
      } finally {
        setRunning(false);
      }
    },
    [address, refreshVenues, refreshChaos],
  );

  const degraded = health.some((h) => h.excludedFromRouting) || forcedOutages.length > 0;

  return (
    <main className="mx-auto max-w-7xl px-4 py-8">
      {/* Header */}
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="harbor-glow text-2xl font-bold tracking-tight text-cyan-100">
            ⚓ Harbor <span className="text-cyan-400">Multi-Protocol Aggregator</span>
          </h1>
          <p className="mt-1 text-xs text-slate-400">
            Cross-vault query & non-custodial action router · 3 on-chain protocols · Pharos Atlantic Testnet (chainId{' '}
            {PHAROS_CHAIN_ID})
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="harbor-badge">Atlantic Testnet · 688689</span>
          <a className="harbor-badge" href="https://atlantic.pharosscan.xyz" target="_blank" rel="noreferrer">
            PharosScan ↗
          </a>
          <WalletBar />
        </div>
      </header>

      {configError && (
        <div className="mb-4 rounded-lg border border-amber-400/40 bg-amber-400/10 p-3 text-xs text-amber-200">
          Setup required: {configError}
        </div>
      )}
      {degraded && (
        <div className="mb-4 rounded-lg border border-rose-400/40 bg-rose-500/10 p-3 text-xs text-rose-200">
          ⚠ DEGRADED MODE ACTIVE — one or more protocols are unavailable. Queries and routing continue across the remaining
          healthy venues (Promise.allSettled + circuit breakers).
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <PortfolioCard portfolio={(response?.portfolio as PortfolioQueryResult) ?? null} loading={venuesLoading} />
        <RateMatrix venues={venues} health={health} />
      </div>

      <div className="mt-4">
        <CommandBar onRun={runCommand} running={running} />
      </div>

      <div className="mt-4">
        <HorizonSimulator venues={venues} health={health} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <RationaleCard rationale={response?.rationale ?? null} />
        <PayloadInspector plan={response?.plan ?? null} user={address ?? null} />
      </div>

      <div className="mt-4">
        <ChaosPanel forcedOutages={forcedOutages} onChange={() => { void refreshChaos(); void refreshVenues(); }} />
      </div>

      {response?.error && (
        <div className="mt-4 rounded-lg border border-slate-600/40 bg-slate-800/40 p-3 text-xs text-slate-300">
          <span className="font-semibold text-amber-300">Agent note: </span>
          {response.error}
        </div>
      )}

      <footer className="mt-8 border-t border-cyan-500/10 pt-4 text-[11px] text-slate-500">
        Non-custodial by construction: the agent core (src/) contains no key material and never broadcasts. Every action is an
        unsigned ABI-encoded payload bound to a keccak256 route commitment over the multi-venue comparison table. See
        ARCHITECTURE.md · tests: <span className="font-mono">npx vitest run</span> · live proof:{' '}
        <span className="font-mono">npm run verify</span>
      </footer>
    </main>
  );
}
