import { describe, expect, it } from 'vitest';
import { PRIME_PARAMS, primeDilutedApyBps, primePostDepositApyBps } from '@/lib/adapters/atlantic-prime';
import { createAtlanticPrimeAdapter } from '@/lib/adapters/atlantic-prime';
import { primeSnapshot, u6, USER, VAULTS } from './helpers';

describe('atlantic-prime: tiered dilution curve', () => {
  it('uses the 940 bps base / 10 bps entry parameterization', () => {
    expect(PRIME_PARAMS.baseApyBps).toBe(940);
    expect(PRIME_PARAMS.entryFeeBps).toBe(10);
    expect(PRIME_PARAMS.exitFeeBps).toBe(0);
    expect(PRIME_PARAMS.dilutionStrength).toBe(0.35);
  });

  it('near-zero utilization pays ~940 bps', () => {
    expect(primeDilutedApyBps(u6(100), u6(60_000))).toBeGreaterThanOrEqual(938);
    expect(primeDilutedApyBps(u6(100), u6(60_000))).toBeLessThanOrEqual(940);
  });

  it('matches the seeded state (10k/60k -> 930 bps)', () => {
    expect(primeDilutedApyBps(u6(10_000), u6(60_000))).toBe(930);
  });

  it('mid utilization dilutes to 919 bps at 15k/60k', () => {
    expect(primeDilutedApyBps(u6(15_000), u6(60_000))).toBe(919);
  });

  it('full capacity compresses to 611 bps (0.35 quadratic dilution)', () => {
    expect(primeDilutedApyBps(u6(60_000), u6(60_000))).toBe(611);
  });

  it('is monotonically non-increasing in deposits', () => {
    let prev = Number.MAX_SAFE_INTEGER;
    for (const ta of [1_000, 5_000, 10_000, 20_000, 40_000, 60_000, 80_000]) {
      const r = primeDilutedApyBps(u6(ta), u6(60_000));
      expect(r).toBeLessThanOrEqual(prev);
      prev = r;
    }
  });

  it('caps at capacity (over-subscribed deposits cannot exceed 611 bps)', () => {
    expect(primeDilutedApyBps(u6(120_000), u6(60_000))).toBe(611);
  });
});

describe('atlantic-prime: post-deposit projection (whale dilution)', () => {
  const model = { cash: u6(10_000), debtOwed: 0n, capacity: u6(60_000) };

  it('small deposits barely dilute (500 -> 929 bps)', () => {
    expect(primePostDepositApyBps(model, u6(500))).toBe(929);
  });

  it('whale deposits dilute hard (50k fills capacity -> 611 bps)', () => {
    expect(primePostDepositApyBps(model, u6(50_000))).toBe(611);
  });

  it('10k deposit reaches 1/3 utilization -> 903 bps', () => {
    expect(primePostDepositApyBps(model, u6(10_000))).toBe(903);
  });

  it('dilution is monotone in deposit size', () => {
    let prev = Number.MAX_SAFE_INTEGER;
    for (const dx of [0, 100, 1_000, 5_000, 10_000, 25_000, 50_000]) {
      const r = primePostDepositApyBps(model, u6(dx));
      expect(r).toBeLessThanOrEqual(prev);
      prev = r;
    }
  });
});

describe('atlantic-prime: adapter behavior', () => {
  const snapshot = primeSnapshot();
  const stubClient = {
    async readContract(args: { functionName: string }) {
      const map: Record<string, unknown> = {
        cash: snapshot.model.cash,
        debtOwed: 0n,
        totalShares: snapshot.totalTvl,
        totalAssets: snapshot.totalTvl,
        entryFeeBps: 10n,
        exitFeeBps: 0n,
        paused: false,
        pauseReason: '',
        utilizationWad: snapshot.utilizationWad,
        spotApyBps: 930n,
        asset: snapshot.underlyingAddress,
        capacity: u6(60_000),
        sharesOf: u6(500),
        principalOf: u6(495),
        convertToAssets: u6(500),
        maxWithdraw: u6(500),
        spotApy: 930n,
      };
      return map[args.functionName];
    },
    async getBlockNumber() {
      return 100n;
    },
  };
  const adapter = createAtlanticPrimeAdapter(VAULTS.ATLANTIC_PRIME, stubClient as never);

  it('exposes the unified interface fields', () => {
    expect(adapter.protocolId).toBe('ATLANTIC_PRIME');
    expect(adapter.label).toBe('AtlanticPrimeStaking');
    expect(adapter.archetype).toContain('Staking');
  });

  it('builds a snapshot including capacity state', async () => {
    const res = await adapter.getSnapshot();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.spotApyBps).toBe(930);
    expect(res.data.entryFeeBps).toBe(10);
    expect(res.data.model.capacity).toBe(u6(60_000));
  });

  it('getPosition applies the 0 bps exit fee (net == spot)', async () => {
    const res = await adapter.getPosition(USER, true);
    expect(res.ok).toBe(true);
    if (!res.ok || !res.data) return;
    expect(res.data.netApyBps).toBe(930);
    expect(res.data.maxWithdrawable).toBe(u6(500));
  });

  it('fails gracefully on RPC errors', async () => {
    const failing = createAtlanticPrimeAdapter(VAULTS.ATLANTIC_PRIME, {
      async readContract() {
        throw new Error('connection refused');
      },
      async getBlockNumber() {
        return 1n;
      },
    } as never);
    const res = await failing.getSnapshot();
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.kind).toBe('RPC_ERROR');
  });

  it('simulatePostDepositApy matches the pure dilution model', () => {
    expect(adapter.simulatePostDepositApy(snapshot, u6(50_000))).toBe(611);
    expect(adapter.simulatePostDepositApy(snapshot, u6(500))).toBe(929);
  });
});
