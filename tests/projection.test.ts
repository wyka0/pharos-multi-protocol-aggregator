import { describe, expect, it } from 'vitest';
import { annualizeBps, candidateDescriptor, evaluateCandidate, projectDepositNetYield, yieldOverHorizon } from '@/lib/adapters/projection';
import { harborSnapshot, primeSnapshot, rwaSnapshot, u6 } from './helpers';

const YEAR_SECONDS = 31_536_000n;

describe('projection: yieldOverHorizon', () => {
  it('full year at 10000 bps doubles nothing (1:1 principal)', () => {
    expect(yieldOverHorizon(1_000_000n, 10_000, 365)).toBe(1_000_000n);
  });
  it('half a year at 5000 bps on $1 yields $0.50', () => {
    expect(yieldOverHorizon(1_000_000n, 5_000, 365)).toBe(500_000n);
  });
  it('one day at 100 bps floors to 27 sub-units', () => {
    expect(yieldOverHorizon(1_000_000n, 100, 1)).toBe(27n);
  });
  it('zero principal yields zero', () => expect(yieldOverHorizon(0n, 900, 30)).toBe(0n));
  it('zero APY yields zero', () => expect(yieldOverHorizon(1_000_000n, 0, 30)).toBe(0n));
  it('zero horizon yields zero', () => expect(yieldOverHorizon(1_000_000n, 900, 0)).toBe(0n));
  it('scales linearly with principal', () => {
    const a = yieldOverHorizon(u6(500), 900, 30);
    const b = yieldOverHorizon(u6(5_000), 900, 30);
    expect(b / a).toBe(10n);
  });
  it('30d at 780 bps on $500 is ~$3.20', () => {
    const g = yieldOverHorizon(u6(500), 780, 30);
    expect(Number(g) / 1e6).toBeGreaterThan(3.19);
    expect(Number(g) / 1e6).toBeLessThan(3.22);
  });
});

describe('projection: annualizeBps', () => {
  it('round-trips a full-year yield', () => {
    const y = yieldOverHorizon(u6(1_000), 800, 365);
    expect(Math.round(annualizeBps(y, u6(1_000), 365))).toBe(800);
  });
  it('annualizes a 30d realized return', () => {
    const y = yieldOverHorizon(u6(1_000), 780, 30);
    const bps = annualizeBps(y, u6(1_000), 30);
    expect(bps).toBeGreaterThan(770);
    expect(bps).toBeLessThan(790);
  });
  it('returns 0 for zero principal or horizon', () => {
    expect(annualizeBps(100n, 0n, 30)).toBe(0);
    expect(annualizeBps(100n, 1_000n, 0)).toBe(0);
  });
  it('annualizes losses as negative bps', () => {
    expect(annualizeBps(-u6(1), u6(1_000), 30)).toBeLessThan(0);
  });
});

describe('projection: projectDepositNetYield (requirement-03 objective)', () => {
  it('subtracts entry fee, gas and applies post-deposit APY to fee-adjusted principal', () => {
    const r = projectDepositNetYield({
      headlineApyBps: 930,
      postDepositApyBps: 929,
      entryFeeBps: 10,
      exitFeeBps: 0,
      amount: u6(500),
      horizonDays: 30,
      gasCostUsdc: 0.02,
      utilizationBeforeWad: 0n,
      utilizationAfterWad: 0n,
    });
    expect(r.entryFeeCost).toBe(u6(0.5));
    expect(r.deployedPrincipal).toBe(u6(499.5));
    expect(r.grossYield).toBeGreaterThan(0n);
    expect(r.netExpectedYield).toBe(r.grossYield - u6(0.5) - 20_000n);
  });
  it('zero entry fee passes principal through', () => {
    const r = projectDepositNetYield({
      headlineApyBps: 780,
      postDepositApyBps: 780,
      entryFeeBps: 0,
      exitFeeBps: 0,
      amount: u6(1_000),
      horizonDays: 30,
      gasCostUsdc: 0,
      utilizationBeforeWad: 0n,
      utilizationAfterWad: 0n,
    });
    expect(r.deployedPrincipal).toBe(u6(1_000));
    expect(r.netExpectedYield).toBe(r.grossYield);
  });
  it('short horizons can produce negative net yield when fees dominate', () => {
    const r = projectDepositNetYield({
      headlineApyBps: 900,
      postDepositApyBps: 900,
      entryFeeBps: 100,
      exitFeeBps: 0,
      amount: u6(10),
      horizonDays: 1,
      gasCostUsdc: 0.02,
      utilizationBeforeWad: 0n,
      utilizationAfterWad: 0n,
    });
    expect(r.netExpectedYield).toBeLessThan(0n);
  });
  it('effective APY approaches headline APY for long horizons and no fees', () => {
    const r = projectDepositNetYield({
      headlineApyBps: 780,
      postDepositApyBps: 780,
      entryFeeBps: 0,
      exitFeeBps: 0,
      amount: u6(1_000),
      horizonDays: 365,
      gasCostUsdc: 0,
      utilizationBeforeWad: 0n,
      utilizationAfterWad: 0n,
    });
    expect(Math.round(r.effectiveNetApyBps)).toBe(780);
  });
});

describe('projection: evaluateCandidate rows', () => {
  it('healthy venue rows carry no rejection reasons', () => {
    const row = evaluateCandidate({
      snapshot: rwaSnapshot(),
      amount: u6(500),
      horizonDays: 30,
      gasCostUsdc: 0.02,
      healthy: true,
      healthReason: '',
      postDepositApyBps: 780,
    });
    expect(row.healthy).toBe(true);
    expect(row.rejectionReasons).toHaveLength(0);
    expect(row.selected).toBe(false);
  });
  it('unhealthy venue rows embed the health reason', () => {
    const row = evaluateCandidate({
      snapshot: rwaSnapshot({ paused: true }),
      amount: u6(500),
      horizonDays: 30,
      gasCostUsdc: 0.02,
      healthy: false,
      healthReason: 'venue unavailable - CIRCUIT_OPEN_PAUSED (Vault paused on-chain)',
      postDepositApyBps: 780,
    });
    expect(row.healthy).toBe(false);
    expect(row.rejectionReasons[0]).toContain('CIRCUIT_OPEN_PAUSED');
  });
  it('entry fee cost flows into the row', () => {
    const row = evaluateCandidate({
      snapshot: primeSnapshot(),
      amount: u6(500),
      horizonDays: 30,
      gasCostUsdc: 0.02,
      healthy: true,
      healthReason: '',
      postDepositApyBps: 929,
    });
    expect(row.entryFeeCost).toBe(u6(0.5));
    expect(row.entryFeeBps).toBe(10);
  });
});

describe('projection: candidateDescriptor stability', () => {
  it('is deterministic for identical rows', () => {
    const mk = () =>
      evaluateCandidate({
        snapshot: harborSnapshot(),
        amount: u6(500),
        horizonDays: 30,
        gasCostUsdc: 0.02,
        healthy: true,
        healthReason: '',
        postDepositApyBps: 760,
      });
    expect(candidateDescriptor(mk())).toBe(candidateDescriptor(mk()));
  });
  it('changes when the venue address changes', () => {
    const a = candidateDescriptor(
      evaluateCandidate({ snapshot: harborSnapshot(), amount: u6(500), horizonDays: 30, gasCostUsdc: 0, healthy: true, healthReason: '', postDepositApyBps: 760 }),
    );
    const b = candidateDescriptor(
      evaluateCandidate({ snapshot: harborSnapshot({ vaultAddress: '0xdead000000000000000000000000000000000001' as `0x${string}` }), amount: u6(500), horizonDays: 30, gasCostUsdc: 0, healthy: true, healthReason: '', postDepositApyBps: 760 }),
    );
    expect(a).not.toBe(b);
  });
  it('changes when net yield changes', () => {
    const a = candidateDescriptor(
      evaluateCandidate({ snapshot: rwaSnapshot(), amount: u6(500), horizonDays: 30, gasCostUsdc: 0, healthy: true, healthReason: '', postDepositApyBps: 780 }),
    );
    const b = candidateDescriptor(
      evaluateCandidate({ snapshot: rwaSnapshot(), amount: u6(500), horizonDays: 60, gasCostUsdc: 0, healthy: true, healthReason: '', postDepositApyBps: 780 }),
    );
    expect(a).not.toBe(b);
  });
});

describe('projection: YEAR_SECONDS sanity', () => {
  it('matches 365 days', () => {
    expect(YEAR_SECONDS).toBe(365n * 24n * 60n * 60n);
  });
});
