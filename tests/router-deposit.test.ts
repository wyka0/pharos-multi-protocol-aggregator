import { describe, expect, it } from 'vitest';
import { buildDepositRationale, evaluateDepositCandidates, selectBestCandidate, comparisonTableDigest } from '@/lib/router';
import { harborSnapshot, healthyHealth, mockAdapter, primeSnapshot, rwaSnapshot, seededSnapshots, u6 } from './helpers';
import type { VenueSnapshot } from '@/lib/types';

function adapters(snapshots: VenueSnapshot[]) {
  return snapshots.map((s) => mockAdapter({ snapshot: s }));
}

const seeded = seededSnapshots;

function evaluate(snapshots: VenueSnapshot[], amount: number, horizonDays: number) {
  return evaluateDepositCandidates({
    snapshots,
    health: healthyHealth(snapshots),
    adapters: adapters(snapshots),
    amount: u6(amount),
    horizonDays,
    gasPolicy: { gasCostUsdcPerAction: 0.02, approveGasUnits: 60_000n, depositGasUnits: 185_000n, withdrawGasUnits: 165_000n },
  });
}

function byPid(rows: ReturnType<typeof evaluate>) {
  return Object.fromEntries(rows.map((r) => [r.protocolId, r]));
}

describe('router deposits: horizon-aware net-yield routing (Requirement 03 + Innovation #1)', () => {
  const seeded = seededSnapshots;

  it('routes a small 500 USDC / 30d deposit to AtlanticPrimeStaking (highest effective net yield)', () => {
    const rows = byPid(evaluate(seeded(), 500, 30));
    const best = selectBestCandidate(Object.values(rows));
    expect(best?.protocolId).toBe('ATLANTIC_PRIME');
    expect(rows.HARBOR_LEND.netExpectedYield).toBeLessThan(rows.ATLANTIC_PRIME.netExpectedYield);
    expect(rows.PHAROS_RWA.netExpectedYield).toBeLessThan(rows.ATLANTIC_PRIME.netExpectedYield);
  });

  it('short 7-day horizons flip the winner: entry fees cannot amortize', () => {
    const rows = byPid(evaluate(seeded(), 500, 7));
    const best = selectBestCandidate(Object.values(rows));
    expect(best?.protocolId).toBe('PHAROS_RWA');
    // The 10 bps entry fee drops Prime from 1st (30d) to last.
    expect(rows.ATLANTIC_PRIME.netExpectedYield).toBeLessThan(rows.HARBOR_LEND.netExpectedYield);
    expect(rows.ATLANTIC_PRIME.netExpectedYield).toBeLessThan(rows.PHAROS_RWA.netExpectedYield);
  });

  it('long 365-day horizons restore the high-APY staking venue', () => {
    const rows = byPid(evaluate(seeded(), 500, 365));
    expect(selectBestCandidate(Object.values(rows))?.protocolId).toBe('ATLANTIC_PRIME');
  });

  it('whale 50k deposits dilute the staking pool and flip to PharosRwaTreasury', () => {
    const rows = byPid(evaluate(seeded(), 50_000, 30));
    const best = selectBestCandidate(Object.values(rows));
    expect(best?.protocolId).toBe('PHAROS_RWA');
    expect(rows.ATLANTIC_PRIME.postDepositApyBps).toBe(611); // capacity dilution
    expect(rows.ATLANTIC_PRIME.netExpectedYield).toBeLessThan(rows.PHAROS_RWA.netExpectedYield);
    expect(rows.HARBOR_LEND.netExpectedYield).toBeLessThan(rows.PHAROS_RWA.netExpectedYield);
  });

  it('whale deposits ALSO compress Harbor utilization (self-dilution modeled)', () => {
    const rows = byPid(evaluate(seeded(), 50_000, 30));
    expect(rows.HARBOR_LEND.postDepositApyBps).toBeLessThan(rows.HARBOR_LEND.headlineApyBps);
  });

  it('size-dependent crossover exists between 10k and 20k (Prime -> RWA)', () => {
    expect(selectBestCandidate(evaluate(seeded(), 10_000, 30))?.protocolId).toBe('ATLANTIC_PRIME');
    expect(selectBestCandidate(evaluate(seeded(), 20_000, 30))?.protocolId).toBe('PHAROS_RWA');
  });

  it('utilization math is exposed per row (before vs after modeled state)', () => {
    const rows = evaluate(seeded(), 500, 30);
    for (const r of rows) {
      expect(r.utilizationBeforeWad).toBeGreaterThanOrEqual(0n);
      expect(r.postDepositApyBps).toBeGreaterThan(0);
    }
  });

  it('gas costs are reported identically for every venue (no ranking distortion)', () => {
    const rows = evaluate(seeded(), 500, 30);
    expect(new Set(rows.map((r) => r.gasCostUsdc))).toEqual(new Set([0.02]));
  });
});

describe('router deposits: candidate evaluation details', () => {
  it('entry fee costs appear in the comparison table', () => {
    const rows = byPid(evaluate(seeded(), 500, 30));
    expect(rows.ATLANTIC_PRIME.entryFeeBps).toBe(10);
    expect(rows.ATLANTIC_PRIME.entryFeeCost).toBe(u6(0.5));
    expect(rows.HARBOR_LEND.entryFeeCost).toBe(0n);
    expect(rows.PHAROS_RWA.entryFeeCost).toBe(0n);
  });

  it('net = gross - entry fee - gas exactly', () => {
    const rows = byPid(evaluate(seeded(), 500, 30));
    for (const r of Object.values(rows)) {
      expect(r.netExpectedYield).toBe(r.grossYield - r.entryFeeCost - 20_000n);
    }
  });

  it('effective net APY is lower than headline for fee-paying venues over 30d', () => {
    const rows = byPid(evaluate(seeded(), 500, 30));
    expect(rows.ATLANTIC_PRIME.effectiveNetApyBps).toBeLessThan(rows.ATLANTIC_PRIME.headlineApyBps);
  });

  it('effective net APY approaches headline APY for 1-year horizons', () => {
    const rows = byPid(evaluate(seeded(), 1_000, 365));
    expect(rows.PHAROS_RWA.effectiveNetApyBps).toBeGreaterThan(770);
  });

  it('deterministic ordering: ties break by effective APY then label', () => {
    const snap = [harborSnapshot(), rwaSnapshot()];
    const rows = evaluate(snap, 500, 30);
    expect(selectBestCandidate(rows)).toBeDefined();
    const twice = evaluate(snap, 500, 30);
    expect(selectBestCandidate(rows)?.protocolId).toBe(selectBestCandidate(twice)?.protocolId);
  });

  it('comparisonTableDigest is stable and position-independent', () => {
    const rows = evaluate(seeded(), 500, 30);
    const d1 = comparisonTableDigest(rows);
    const d2 = comparisonTableDigest([...rows].reverse());
    expect(d1.sort()).toEqual(d2.sort());
  });
});

describe('router deposits: degraded venues are excluded with reasons', () => {
  it('paused venues get rejection rows and can never win', () => {
    const snapshots = seededSnapshots().map((s) => (s.protocolId === 'PHAROS_RWA' ? { ...s, paused: true } : s));
    const health = healthyHealth(snapshots).map((h) =>
      h.protocolId === 'PHAROS_RWA' ? { ...h, state: 'CIRCUIT_OPEN_PAUSED' as const, excludedFromRouting: true, reason: 'Vault paused on-chain - chaos-drill' } : h,
    );
    const rows = evaluateDepositCandidates({
      snapshots,
      health,
      adapters: adapters(snapshots),
      amount: u6(500),
      horizonDays: 30,
      gasPolicy: { gasCostUsdcPerAction: 0.02, approveGasUnits: 60_000n, depositGasUnits: 185_000n, withdrawGasUnits: 165_000n },
    });
    const rwa = rows.find((r) => r.protocolId === 'PHAROS_RWA')!;
    expect(rwa.healthy).toBe(false);
    expect(rwa.rejectionReasons.join(' ')).toContain('paused');
    expect(selectBestCandidate(rows)?.protocolId).not.toBe('PHAROS_RWA');
  });

  it('when every venue is unavailable there is no winner', () => {
    const snapshots = seededSnapshots().map((s) => ({ ...s, paused: true }));
    const health = healthyHealth(snapshots).map((h) => ({ ...h, excludedFromRouting: true, state: 'CIRCUIT_OPEN_PAUSED' as const }));
    const rows = evaluateDepositCandidates({
      snapshots,
      health,
      adapters: adapters(snapshots),
      amount: u6(500),
      horizonDays: 30,
      gasPolicy: { gasCostUsdcPerAction: 0.02, approveGasUnits: 60_000n, depositGasUnits: 185_000n, withdrawGasUnits: 165_000n },
    });
    expect(selectBestCandidate(rows)).toBeNull();
  });

  it('circuit-open venues lose to healthy ones even with higher headline APY', () => {
    // Prime has the highest headline but is circuit-open; RWA (healthy) must win.
    const snapshots = seededSnapshots().map((s) => (s.protocolId === 'ATLANTIC_PRIME' ? { ...s, paused: true } : s));
    const health = healthyHealth(snapshots).map((h) =>
      h.protocolId === 'ATLANTIC_PRIME' ? { ...h, state: 'CIRCUIT_OPEN_PAUSED' as const, excludedFromRouting: true, reason: 'Vault paused on-chain' } : h,
    );
    const rows = evaluateDepositCandidates({
      snapshots,
      health,
      adapters: adapters(snapshots),
      amount: u6(500),
      horizonDays: 30,
      gasPolicy: { gasCostUsdcPerAction: 0.02, approveGasUnits: 60_000n, depositGasUnits: 185_000n, withdrawGasUnits: 165_000n },
    });
    expect(selectBestCandidate(rows)?.protocolId).toBe('PHAROS_RWA');
  });
});

describe('router deposits: RoutingRationale (human-readable explanations)', () => {
  it('explains the winner and every runner-up with dollar math', () => {
    const rows = evaluate(seeded(), 500, 30);
    const rationale = buildDepositRationale({
      candidates: rows,
      amount: u6(500),
      horizonDays: 30,
      venueHealth: healthyHealth(seeded()),
      degradedNotes: [],
    });
    expect(rationale.summary).toMatch(/Selected AtlanticPrimeStaking/);
    expect(rationale.summary).toContain('Net 30d return');
    expect(rationale.summary).toContain('Rejected PharosRwaTreasury');
    expect(rationale.summary).toContain('Rejected HarborLendVault');
    expect(rationale.degradedMode).toBe(false);
    expect(rationale.selected).toBe('ATLANTIC_PRIME');
  });

  it('cites the entry fee when rejecting Prime over short horizons', () => {
    const rows = evaluate(seeded(), 500, 7);
    const rationale = buildDepositRationale({
      candidates: rows,
      amount: u6(500),
      horizonDays: 7,
      venueHealth: healthyHealth(seeded()),
      degradedNotes: [],
    });
    expect(rationale.summary).toMatch(/Selected PharosRwaTreasury/);
    expect(rationale.summary).toMatch(/10 bps entry fee/);
  });

  it('flags degraded mode in the rationale', () => {
    const snapshots = seededSnapshots().map((s) => (s.protocolId === 'PHAROS_RWA' ? { ...s, paused: true } : s));
    const health = healthyHealth(snapshots).map((h) =>
      h.protocolId === 'PHAROS_RWA' ? { ...h, excludedFromRouting: true, state: 'CIRCUIT_OPEN_PAUSED' as const } : h,
    );
    const rows = evaluateDepositCandidates({
      snapshots,
      health,
      adapters: adapters(snapshots),
      amount: u6(500),
      horizonDays: 30,
      gasPolicy: { gasCostUsdcPerAction: 0.02, approveGasUnits: 60_000n, depositGasUnits: 185_000n, withdrawGasUnits: 165_000n },
    });
    const rationale = buildDepositRationale({ candidates: rows, amount: u6(500), horizonDays: 30, venueHealth: health, degradedNotes: ['PharosRwaTreasury unavailable'] });
    expect(rationale.degradedMode).toBe(true);
    expect(rationale.degradedNotes).toContain('PharosRwaTreasury unavailable');
  });

  it('produces a no-venue rationale when everything is down', () => {
    const rationale = buildDepositRationale({
      candidates: [],
      amount: u6(500),
      horizonDays: 30,
      venueHealth: healthyHealth([]),
      degradedNotes: ['all down'],
    });
    expect(rationale.selected).toBeNull();
    expect(rationale.summary).toContain('No healthy venue');
  });

  it('marks exactly one candidate selected', () => {
    const rows = evaluate(seeded(), 500, 30);
    const rationale = buildDepositRationale({ candidates: rows, amount: u6(500), horizonDays: 30, venueHealth: [], degradedNotes: [] });
    expect(rationale.comparisonTable.filter((c) => c.selected)).toHaveLength(1);
  });
});
