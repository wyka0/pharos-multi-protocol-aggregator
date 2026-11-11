import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HarborAggregator, DEFAULT_AGGREGATOR_CONFIG } from '@/lib/aggregator';
import { ResilientAdapterMesh } from '@/lib/resilience';
import { ChaosRegistry } from '@/lib/chaos';
import type { Address } from 'viem';
import { harborSnapshot, healthyHealth, mockAdapter, position, primeSnapshot, rwaSnapshot, seededSnapshots, u6, USER, VAULTS } from './helpers';

const TUSDC = '0xbbbb000000000000000000000000000000000001' as Address;

function makeAggregator(specs: Parameters<typeof mockAdapter>[0][], meshConfig = { timeoutMs: 500, failureThreshold: 3, cooldownMs: 1_000 }, chaos = new ChaosRegistry()) {
  const adapters = specs.map((s) => mockAdapter(s));
  const mesh = new ResilientAdapterMesh(adapters, meshConfig, chaos);
  return new HarborAggregator(mesh, { ...DEFAULT_AGGREGATOR_CONFIG, underlyingAddress: TUSDC });
}

const healthySpecs = (): Parameters<typeof mockAdapter>[0][] => [
  { snapshot: harborSnapshot(), position: position('HARBOR_LEND') },
  { snapshot: primeSnapshot(), position: position('ATLANTIC_PRIME') },
  { snapshot: rwaSnapshot(), position: position('PHAROS_RWA') },
];

describe('aggregator: unified portfolio queries (Requirement 02.1)', () => {
  it('aggregates positions, totals and weighted net APY across all 3 protocols', async () => {
    const agg = makeAggregator(healthySpecs());
    const portfolio = await agg.queryPortfolio(USER);
    expect(portfolio.positions).toHaveLength(3);
    expect(portfolio.totals.underlyingValue).toBe(u6(1_500));
    expect(portfolio.totals.accruedYield).toBe(u6(6));
    expect(portfolio.totals.positionsCount).toBe(3);
    expect(portfolio.weightedNetApyBps).toBeGreaterThan(700);
    expect(portfolio.weightedNetApyBps).toBeLessThan(1_000);
  });

  it('excludes paused venues from totals but keeps them visible', async () => {
    const specs = healthySpecs();
    specs[2].snapshot = rwaSnapshot({ paused: true, pauseReason: 'drill' });
    const agg = makeAggregator(specs);
    const portfolio = await agg.queryPortfolio(USER);
    expect(portfolio.positions).toHaveLength(2);
    expect(portfolio.totals.underlyingValue).toBe(u6(1_000));
    expect(portfolio.excluded).toHaveLength(1);
    expect(portfolio.excluded[0].protocolId).toBe('PHAROS_RWA');
    expect(portfolio.excluded[0].reason).toContain('paused');
  });

  it('handles a null user without crashing (anonymous rate view)', async () => {
    const agg = makeAggregator(healthySpecs());
    const portfolio = await agg.queryPortfolio(null);
    expect(portfolio.user).toBeNull();
    expect(portfolio.positions).toHaveLength(0);
    expect(portfolio.totals.underlyingValue).toBe(0n);
  });

  it('compareRates returns the 3-vault rate matrix with health', async () => {
    const agg = makeAggregator(healthySpecs());
    const rates = await agg.compareRates(30);
    expect(rates.venues).toHaveLength(3);
    expect(rates.venues.map((v) => v.spotApyBps).sort((a, b) => b - a)).toEqual([930, 780, 764]);
    expect(rates.venues.every((v) => v.healthy)).toBe(true);
  });
});

describe('aggregator: planDeposit (Requirement 02.2 + 03)', () => {
  it('routes 500 USDC to Prime with a full rationale + unsigned payload', async () => {
    const agg = makeAggregator(healthySpecs());
    const res = await agg.planDeposit({ user: USER, amount: 500, horizonDays: 30, target: 'best', parsedFrom: 'Deposit 500 USDC into the best yield vault' });
    expect(res.ok).toBe(true);
    expect(res.plan).not.toBeNull();
    expect(res.plan!.selectedProtocol).toBe('ATLANTIC_PRIME');
    expect(res.rationale.summary).toContain('Selected AtlanticPrimeStaking');
    expect(res.rationale.comparisonTable).toHaveLength(3);
    expect(res.plan!.legs.map((l) => l.kind)).toEqual(['approve', 'deposit']);
  });

  it('routes whale deposits away from the diluting staking vault', async () => {
    const agg = makeAggregator(healthySpecs());
    const res = await agg.planDeposit({ user: USER, amount: 50_000, horizonDays: 30, target: 'best', parsedFrom: 'Deposit 50,000 USDC' });
    expect(res.plan!.selectedProtocol).toBe('PHAROS_RWA');
  });

  it('honors a pinned venue target', async () => {
    const agg = makeAggregator(healthySpecs());
    const res = await agg.planDeposit({ user: USER, amount: 100, horizonDays: 30, target: 'HARBOR_LEND', parsedFrom: 'deposit into harbor' });
    expect(res.ok).toBe(true);
    expect(res.plan!.selectedProtocol).toBe('HARBOR_LEND');
  });

  it('refuses pinned targets that are unavailable (no silent re-routing)', async () => {
    const specs = healthySpecs();
    specs[2].snapshot = rwaSnapshot({ paused: true, pauseReason: 'drill' });
    const agg = makeAggregator(specs);
    const res = await agg.planDeposit({ user: USER, amount: 100, horizonDays: 30, target: 'PHAROS_RWA', parsedFrom: 'deposit into rwa' });
    expect(res.ok).toBe(false);
    expect(res.plan).toBeNull();
    expect(res.rationale.summary).toContain('unavailable');
    expect(res.banner).toContain('DEGRADED MODE');
  });

  it('degrades to ok:false with a rationale when no venue is healthy', async () => {
    const specs = healthySpecs().map((s) => ({ ...s, snapshot: { ...s.snapshot!, paused: true } }));
    const agg = makeAggregator(specs);
    const res = await agg.planDeposit({ user: USER, amount: 100, horizonDays: 30, target: 'best', parsedFrom: 'x' });
    expect(res.ok).toBe(false);
    expect(res.plan).toBeNull();
    expect(res.rationale.summary).toContain('No healthy venue');
  });

  it('payloads pass the runtime airgap assertion', async () => {
    const agg = makeAggregator(healthySpecs());
    const res = await agg.planDeposit({ user: USER, amount: 500, horizonDays: 30, target: 'best', parsedFrom: 'x' });
    expect(res.plan!.harborRouteCommitment).toMatch(/^0x[0-9a-f]{64}$/);
    expect(res.plan!.legs.every((l) => l.value === '0' && l.chainId === 688689)).toBe(true);
  });
});

describe('aggregator: planWithdrawal (Requirement 02.2 + Innovation #3)', () => {
  it('prepares the lowest-yield exit and explains opportunity cost', async () => {
    const agg = makeAggregator(healthySpecs());
    const res = await agg.planWithdrawal({ user: USER, amount: 200, horizonDays: 30, source: 'lowest-yield', parsedFrom: 'Withdraw 200 USDC from my lowest-yielding position' });
    expect(res.ok).toBe(true);
    expect(res.plan!.selectedProtocol).toBe('HARBOR_LEND');
    expect(res.rationale.summary).toContain('lowest net APY');
    expect(res.plan!.legs).toHaveLength(1);
  });

  it('splits withdrawals across venues when a single position cannot cover it', async () => {
    const specs = healthySpecs();
    // Harbor position capped at 100 -> 250 USDC request needs Prime too.
    specs[0].position = position('HARBOR_LEND', { maxWithdrawable: u6(100) });
    const agg = makeAggregator(specs);
    const res = await agg.planWithdrawal({ user: USER, amount: 250, horizonDays: 30, source: 'lowest-yield', parsedFrom: 'Withdraw 250 USDC' });
    expect(res.ok).toBe(true);
    expect(res.plan!.legs).toHaveLength(2);
    expect(res.plan!.legs[0].amountRaw).toBe(u6(100).toString());
    expect(res.plan!.legs[1].amountRaw).toBe(u6(150).toString());
  });

  it('fails gracefully with a shortfall rationale', async () => {
    const specs = healthySpecs();
    specs[0].position = position('HARBOR_LEND', { maxWithdrawable: u6(50) });
    specs[1].position = position('ATLANTIC_PRIME', { maxWithdrawable: u6(50) });
    specs[2].position = position('PHAROS_RWA', { maxWithdrawable: u6(50) });
    const agg = makeAggregator(specs);
    const res = await agg.planWithdrawal({ user: USER, amount: 1_000, horizonDays: 30, source: 'lowest-yield', parsedFrom: 'x' });
    expect(res.ok).toBe(false);
    expect(res.plan).toBeNull();
    expect(res.rationale.summary).toContain('Partial plan');
  });

  it('withdraws only from healthy venues under degradation', async () => {
    const specs = healthySpecs();
    specs[0].snapshot = harborSnapshot({ paused: true });
    const agg = makeAggregator(specs);
    const res = await agg.planWithdrawal({ user: USER, amount: 300, horizonDays: 30, source: 'lowest-yield', parsedFrom: 'x' });
    expect(res.ok).toBe(true);
    expect(res.plan!.legs.every((l) => l.kind === 'withdraw')).toBe(true);
    expect(res.plan!.selectedProtocol).not.toBe('HARBOR_LEND');
    expect(res.rationale.degradedMode).toBe(true);
  });
});

describe('aggregator: unified NL entrypoint (handle)', () => {
  it('routes portfolio NL queries end-to-end', async () => {
    const agg = makeAggregator(healthySpecs());
    const resp = await agg.handle({ text: 'Show my positions and current APY across all vaults', user: USER });
    expect(resp.ok).toBe(true);
    expect(resp.mode).toBe('query');
    expect(resp.portfolio!.positions).toHaveLength(3);
  });

  it('routes rate comparison NL queries end-to-end', async () => {
    const agg = makeAggregator(healthySpecs());
    const resp = await agg.handle({ text: 'Compare yield rates and available liquidity', user: USER });
    expect(resp.ok).toBe(true);
    expect(resp.rates!.venues).toHaveLength(3);
  });

  it('routes deposit NL commands end-to-end', async () => {
    const agg = makeAggregator(healthySpecs());
    const resp = await agg.handle({ text: 'Deposit 500 USDC into the best yield vault', user: USER });
    expect(resp.ok).toBe(true);
    expect(resp.mode).toBe('action');
    expect(resp.plan!.selectedProtocol).toBe('ATLANTIC_PRIME');
    expect(resp.intent.kind).toBe('deposit');
  });

  it('routes withdraw NL commands end-to-end', async () => {
    const agg = makeAggregator(healthySpecs());
    const resp = await agg.handle({ text: 'Withdraw 200 USDC from my lowest-yielding position', user: USER });
    expect(resp.ok).toBe(true);
    expect(resp.plan!.selectedProtocol).toBe('HARBOR_LEND');
  });

  it('accepts structured intents', async () => {
    const agg = makeAggregator(healthySpecs());
    const resp = await agg.handle({ structured: { action: 'deposit', amount: 25_000, horizonDays: 14 }, user: USER });
    expect(resp.ok).toBe(true);
    expect(resp.plan!.amount).toBe(u6(25_000));
    expect(resp.plan!.horizonDays).toBe(14);
  });

  it('refuses actions without a user address (non-custodial posture)', async () => {
    const agg = makeAggregator(healthySpecs());
    const resp = await agg.handle({ text: 'Deposit 500 USDC', user: null });
    expect(resp.ok).toBe(false);
    expect(resp.error).toContain('non-custodial');
  });

  it('returns a helpful unknown-intent response for gibberish', async () => {
    const agg = makeAggregator(healthySpecs());
    const resp = await agg.handle({ text: 'asdkjhaskdjh', user: USER });
    expect(resp.ok).toBe(false);
    expect(resp.intent.kind).toBe('unknown');
    expect(resp.error).toBeTruthy();
  });

  it('never throws - internal faults become structured degraded responses', async () => {
    const agg = makeAggregator(healthySpecs());
    // Simulate a core fault by passing a broken structured payload through a poisoned mesh.
    const poison = makeAggregator(healthySpecs());
    (poison as unknown as { mesh: { fetchAllSnapshots: () => Promise<never> } }).mesh = {
      fetchAllSnapshots: () => Promise.reject(new Error('catastrophic')),
    } as never;
    const resp = await poison.handle({ text: 'Deposit 500 USDC', user: USER });
    expect(resp.ok).toBe(false);
    expect(resp.error).toContain('degraded gracefully');
  });
});

describe('aggregator: evidence rendering', () => {
  it('renders a comparison table with all venues', async () => {
    const agg = makeAggregator(healthySpecs());
    const res = await agg.planDeposit({ user: USER, amount: 500, horizonDays: 30, target: 'best', parsedFrom: 'x' });
    const table = agg.renderComparisonTable(res.rationale!.comparisonTable, 30);
    expect(table).toContain('HarborLendVault');
    expect(table).toContain('AtlanticPrimeStaking');
    expect(table).toContain('PharosRwaTreasury');
    expect(table).toContain('net 30d');
  });

  it('renders a confirmation card for plans', async () => {
    const agg = makeAggregator(healthySpecs());
    const res = await agg.planDeposit({ user: USER, amount: 500, horizonDays: 30, target: 'best', parsedFrom: 'x' });
    const card = agg.confirmationCard(res.plan!);
    expect(card).toContain('HARBOR DEPOSIT PLAN');
  });
});
