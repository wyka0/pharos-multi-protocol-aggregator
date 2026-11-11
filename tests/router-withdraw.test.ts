import { describe, expect, it } from 'vitest';
import { planOptimalWithdrawal } from '@/lib/router';
import type { UserPosition, VenueHealthEntry } from '@/lib/types';
import { position, healthyHealth, u6, seededSnapshots } from './helpers';

const gasPolicy = { gasCostUsdcPerAction: 0.02, approveGasUnits: 60_000n, depositGasUnits: 185_000n, withdrawGasUnits: 165_000n };

function twoPositionPortfolio(): UserPosition[] {
  return [position('HARBOR_LEND'), position('ATLANTIC_PRIME')]; // 763 vs 930 net APY, 500 each
}

function health(positions: UserPosition[], snapshots = seededSnapshots()): VenueHealthEntry[] {
  return healthyHealth(snapshots);
}

describe('router withdrawals: opportunity-cost routing (Requirement 03)', () => {
  it('withdraws from the LOWEST net-APY position first', () => {
    const res = planOptimalWithdrawal({ positions: twoPositionPortfolio(), health: health(twoPositionPortfolio()), amount: u6(200), horizonDays: 30, gasPolicy, source: 'lowest-yield' });
    expect(res.ok).toBe(true);
    expect(res.legs).toHaveLength(1);
    expect(res.legs[0].protocolId).toBe('HARBOR_LEND');
    expect(res.legs[0].netAmount).toBe(u6(200));
    expect(res.selected).toBe('HARBOR_LEND');
  });

  it('explains the opportunity cost of the choice vs the alternative', () => {
    const res = planOptimalWithdrawal({ positions: twoPositionPortfolio(), health: health(twoPositionPortfolio()), amount: u6(200), horizonDays: 30, gasPolicy, source: 'lowest-yield' });
    expect(res.rationale.summary).toContain('Selected HarborLendVault');
    expect(res.rationale.summary).toContain('lowest net APY');
  });

  it('higher-APY exits are honored when explicitly requested via "best"', () => {
    const res = planOptimalWithdrawal({ positions: twoPositionPortfolio(), health: health(twoPositionPortfolio()), amount: u6(100), horizonDays: 30, gasPolicy, source: 'best' });
    expect(res.legs[0].protocolId).toBe('ATLANTIC_PRIME');
  });

  it('pinned protocol withdrawals use only that venue', () => {
    const res = planOptimalWithdrawal({ positions: twoPositionPortfolio(), health: health(twoPositionPortfolio()), amount: u6(100), horizonDays: 30, gasPolicy, source: 'ATLANTIC_PRIME' });
    expect(res.legs).toHaveLength(1);
    expect(res.legs[0].protocolId).toBe('ATLANTIC_PRIME');
  });

  it('preserves the highest-yield position when draining the lowest (yield preservation math)', () => {
    const res = planOptimalWithdrawal({ positions: twoPositionPortfolio(), health: health(twoPositionPortfolio()), amount: u6(200), horizonDays: 30, gasPolicy, source: 'lowest-yield' });
    const harborCost = Number(res.rationale.comparisonTable.find((c) => c.protocolId === 'HARBOR_LEND')!.netExpectedYield);
    const primeCost = Number(res.rationale.comparisonTable.find((c) => c.protocolId === 'ATLANTIC_PRIME')!.netExpectedYield);
    expect(harborCost).toBeGreaterThan(primeCost); // exiting Prime costs more yield
  });
});

describe('router withdrawals: multi-vault split solver (Innovation #3)', () => {
  it('splits an 800 USDC withdrawal across two venues (drain the lower-APY vault first)', () => {
    const res = planOptimalWithdrawal({ positions: twoPositionPortfolio(), health: health(twoPositionPortfolio()), amount: u6(800), horizonDays: 30, gasPolicy, source: 'lowest-yield' });
    expect(res.ok).toBe(true);
    expect(res.legs).toHaveLength(2);
    expect(res.legs[0].protocolId).toBe('HARBOR_LEND');
    expect(res.legs[0].netAmount).toBe(u6(499)); // full drain of Harbor (exit-fee-adjusted cap)
    expect(res.legs[1].protocolId).toBe('ATLANTIC_PRIME');
    expect(res.legs[1].netAmount).toBe(u6(301)); // remainder from Prime
    expect(res.rationale.summary).toContain('Split withdrawal across 2 venues');
    expect(res.rationale.summary).toContain('lowest-yielding venue first');
  });

  it('liquidity-capped positions produce a 2-leg plan with adjusted amounts', () => {
    const positions = [
      position('HARBOR_LEND', { maxWithdrawable: u6(250) }),
      position('ATLANTIC_PRIME', { maxWithdrawable: u6(500) }),
    ];
    const res = planOptimalWithdrawal({ positions, health: health(positions), amount: u6(600), horizonDays: 30, gasPolicy, source: 'lowest-yield' });
    expect(res.ok).toBe(true);
    expect(res.legs).toHaveLength(2);
    expect(res.legs[0].netAmount).toBe(u6(250));
    expect(res.legs[1].netAmount).toBe(u6(350));
  });

  it('three-position portfolios drain in ascending net-APY order', () => {
    const positions = [
      position('ATLANTIC_PRIME', { underlyingValue: u6(100), maxWithdrawable: u6(100), netApyBps: 930 }),
      position('HARBOR_LEND', { underlyingValue: u6(200), maxWithdrawable: u6(200), netApyBps: 763 }),
      position('PHAROS_RWA', { underlyingValue: u6(300), maxWithdrawable: u6(300), netApyBps: 780 }),
    ];
    const res = planOptimalWithdrawal({ positions, health: health(positions), amount: u6(450), horizonDays: 30, gasPolicy, source: 'lowest-yield' });
    expect(res.legs.map((l) => l.protocolId)).toEqual(['HARBOR_LEND', 'PHAROS_RWA']);
    expect(res.legs[0].netAmount).toBe(u6(200));
    expect(res.legs[1].netAmount).toBe(u6(250));
  });

  it('venues excluded by health are removed from the plan with degraded notes', () => {
    const positions = twoPositionPortfolio();
    const snapshots = seededSnapshots();
    const h = healthyHealth(snapshots).map((x) =>
      x.protocolId === 'ATLANTIC_PRIME' ? { ...x, excludedFromRouting: true, state: 'CIRCUIT_OPEN_PAUSED' as const, reason: 'Vault paused on-chain' } : x,
    );
    const res = planOptimalWithdrawal({ positions, health: h, amount: u6(400), horizonDays: 30, gasPolicy, source: 'lowest-yield' });
    expect(res.ok).toBe(true);
    expect(res.legs).toHaveLength(1);
    expect(res.legs[0].protocolId).toBe('HARBOR_LEND');
    expect(res.rationale.degradedMode).toBe(true);
    expect(res.rationale.degradedNotes.join(' ')).toContain('AtlanticPrimeStaking');
  });
});

describe('router withdrawals: failure modes stay graceful', () => {
  it('reports a shortfall when balances cannot cover the request', () => {
    const positions = [position('HARBOR_LEND', { maxWithdrawable: u6(100) })];
    const res = planOptimalWithdrawal({ positions, health: health(positions), amount: u6(400), horizonDays: 30, gasPolicy, source: 'lowest-yield' });
    expect(res.ok).toBe(false);
    expect(res.shortfall).toBe(u6(300));
    expect(res.rationale.summary).toContain('Partial plan');
    expect(res.rationale.summary).toContain('300.00');
  });

  it('returns an empty plan when the user has no positions', () => {
    const res = planOptimalWithdrawal({ positions: [], health: health([]), amount: u6(100), horizonDays: 30, gasPolicy, source: 'lowest-yield' });
    expect(res.ok).toBe(false);
    expect(res.legs).toHaveLength(0);
    expect(res.rationale.summary).toContain('no healthy position');
  });

  it('returns an empty plan when every holding venue is excluded', () => {
    const positions = twoPositionPortfolio();
    const snapshots = seededSnapshots();
    const h = healthyHealth(snapshots).map((x) => ({ ...x, excludedFromRouting: true, state: 'CIRCUIT_OPEN' as const, reason: 'circuit open' }));
    const res = planOptimalWithdrawal({ positions, health: h, amount: u6(100), horizonDays: 30, gasPolicy, source: 'lowest-yield' });
    expect(res.ok).toBe(false);
    expect(res.rationale.degradedMode).toBe(true);
  });

  it('ignores zero-liquidity positions', () => {
    const positions = [
      position('HARBOR_LEND', { maxWithdrawable: 0n }),
      position('ATLANTIC_PRIME', { maxWithdrawable: u6(50) }),
    ];
    const res = planOptimalWithdrawal({ positions, health: health(positions), amount: u6(50), horizonDays: 30, gasPolicy, source: 'lowest-yield' });
    expect(res.ok).toBe(true);
    expect(res.legs).toHaveLength(1);
    expect(res.legs[0].protocolId).toBe('ATLANTIC_PRIME');
  });

  it('is deterministic across repeated calls', () => {
    const a = planOptimalWithdrawal({ positions: twoPositionPortfolio(), health: health(twoPositionPortfolio()), amount: u6(700), horizonDays: 30, gasPolicy, source: 'lowest-yield' });
    const b = planOptimalWithdrawal({ positions: twoPositionPortfolio(), health: health(twoPositionPortfolio()), amount: u6(700), horizonDays: 30, gasPolicy, source: 'lowest-yield' });
    expect(a.legs.map((l) => [l.protocolId, l.netAmount.toString()])).toEqual(b.legs.map((l) => [l.protocolId, l.netAmount.toString()]));
  });
});

describe('router withdrawals: opportunity-cost accounting', () => {
  it('computes foregone yield over the requested horizon', () => {
    const res = planOptimalWithdrawal({ positions: twoPositionPortfolio(), health: health(twoPositionPortfolio()), amount: u6(200), horizonDays: 30, gasPolicy, source: 'lowest-yield' });
    const leg = res.legs[0];
    // 200 USDC at ~7.63% for 30d ~ $1.25
    expect(leg.opportunityCostPreserved).toMatch(/1\.2\d USDC of 30d yield foregone/);
  });

  it('longer horizons raise the foregone yield (horizon-aware exits)', () => {
    const short = planOptimalWithdrawal({ positions: twoPositionPortfolio(), health: health(twoPositionPortfolio()), amount: u6(200), horizonDays: 7, gasPolicy, source: 'lowest-yield' });
    const long = planOptimalWithdrawal({ positions: twoPositionPortfolio(), health: health(twoPositionPortfolio()), amount: u6(200), horizonDays: 365, gasPolicy, source: 'lowest-yield' });
    const shortCost = short.rationale.comparisonTable.find((c) => c.protocolId === 'HARBOR_LEND')!.netExpectedYield;
    const longCost = long.rationale.comparisonTable.find((c) => c.protocolId === 'HARBOR_LEND')!.netExpectedYield;
    expect(longCost).toBeLessThan(shortCost); // more negative = bigger opportunity cost
  });

  it('runner-up rejections explain why other positions were kept', () => {
    const res = planOptimalWithdrawal({ positions: twoPositionPortfolio(), health: health(twoPositionPortfolio()), amount: u6(200), horizonDays: 30, gasPolicy, source: 'lowest-yield' });
    const primeRow = res.rationale.runnerUps.find((r) => r.protocolId === 'ATLANTIC_PRIME');
    expect(primeRow).toBeDefined();
    expect(primeRow!.reason).toContain('not needed');
  });
});
