import { describe, expect, it } from 'vitest';
import { HarborAggregator, DEFAULT_AGGREGATOR_CONFIG } from '@/lib/aggregator';
import { ResilientAdapterMesh } from '@/lib/resilience';
import { ChaosRegistry } from '@/lib/chaos';
import type { Address } from 'viem';
import { harborSnapshot, mockAdapter, position, primeSnapshot, rwaSnapshot, seededSnapshots, u6, USER, VAULTS } from './helpers';

/* ========================================================================== */
/* Integration: full stack (intent -> mesh -> router -> payload) under faults. */
/* Proves the requirement-04 guarantee at the aggregate level: 1 or 2 venues   */
/* down, queries + routing keep working with explicit degraded banners.        */
/* ========================================================================== */

const TUSDC = '0xbbbb000000000000000000000000000000000001' as Address;

function build(specs: Parameters<typeof mockAdapter>[0][], meshConfig = { timeoutMs: 300, failureThreshold: 2, cooldownMs: 10_000 }, chaos = new ChaosRegistry()) {
  const mesh = new ResilientAdapterMesh(specs.map((s) => mockAdapter(s)), meshConfig, chaos);
  return new HarborAggregator(mesh, { ...DEFAULT_AGGREGATOR_CONFIG, underlyingAddress: TUSDC });
}

function healthySpecs(): Parameters<typeof mockAdapter>[0][] {
  return [
    { snapshot: harborSnapshot(), position: position('HARBOR_LEND') },
    { snapshot: primeSnapshot(), position: position('ATLANTIC_PRIME') },
    { snapshot: rwaSnapshot(), position: position('PHAROS_RWA') },
  ];
}

describe('integration: one protocol unavailable (paused)', () => {
  it('queries keep serving the 2 healthy venues with a degraded banner', async () => {
    const specs = healthySpecs();
    specs[2].snapshot = rwaSnapshot({ paused: true, pauseReason: 'chaos-drill' });
    const agg = build(specs);
    const resp = await agg.handle({ text: 'Show my positions and current APY across all vaults', user: USER });
    expect(resp.ok).toBe(true);
    expect(resp.degradedMode).toBe(true);
    expect(resp.banner).toContain('DEGRADED MODE');
    expect(resp.banner).toContain('PharosRwaTreasury');
    expect(resp.portfolio!.perVenue).toHaveLength(2);
    expect(resp.portfolio!.excluded[0].state).toBe('CIRCUIT_OPEN_PAUSED');
  });

  it('deposits re-route to the best HEALTHY venue automatically', async () => {
    const specs = healthySpecs();
    specs[2].snapshot = rwaSnapshot({ paused: true });
    const agg = build(specs);
    const resp = await agg.handle({ text: 'Deposit 500 USDC into the best yield vault', user: USER });
    expect(resp.ok).toBe(true);
    expect(resp.plan!.selectedProtocol).toBe('ATLANTIC_PRIME'); // RWA excluded, Prime beats Harbor
    expect(resp.rationale!.degradedMode).toBe(true);
    expect(resp.rationale!.comparisonTable.find((c) => c.protocolId === 'PHAROS_RWA')!.healthy).toBe(false);
  });

  it('withdrawals exclude the dead venue but still succeed', async () => {
    const specs = healthySpecs();
    specs[2].snapshot = rwaSnapshot({ paused: true });
    const agg = build(specs);
    const resp = await agg.handle({ text: 'Withdraw 200 USDC', user: USER });
    expect(resp.ok).toBe(true);
    expect(resp.plan!.selectedProtocol).not.toBe('PHAROS_RWA');
    expect(resp.rationale!.degradedNotes.join(' ')).toContain('PharosRwaTreasury');
  });
});

describe('integration: RPC chaos (simulated timeout/revert)', () => {
  it('chaos-killed venues degrade queries, healthy ones keep working', async () => {
    const chaos = new ChaosRegistry();
    chaos.setForced('ATLANTIC_PRIME', 'TIMEOUT', 'drill');
    const agg = build(healthySpecs(), { timeoutMs: 300, failureThreshold: 2, cooldownMs: 10_000 }, chaos);
    const resp = await agg.handle({ text: 'Compare yield rates and available liquidity', user: USER });
    expect(resp.ok).toBe(true);
    expect(resp.rates!.venues.map((v) => v.protocolId)).not.toContain('ATLANTIC_PRIME');
    expect(resp.rates!.excluded.map((e) => e.protocolId)).toContain('ATLANTIC_PRIME');
  });

  it('breaker opens after threshold and deposits route around the dead venue', async () => {
    const chaos = new ChaosRegistry();
    chaos.setForced('ATLANTIC_PRIME', 'RPC_REVERT', 'drill');
    const agg = build(healthySpecs(), { timeoutMs: 300, failureThreshold: 2, cooldownMs: 10_000 }, chaos);
    // Two rounds to trip the breaker.
    await agg.handle({ text: 'Compare yield rates', user: USER });
    await agg.handle({ text: 'Compare yield rates', user: USER });
    const resp = await agg.handle({ text: 'Deposit 500 USDC into the best yield vault', user: USER });
    expect(resp.ok).toBe(true);
    expect(resp.plan!.selectedProtocol).toBe('PHAROS_RWA'); // 500 @ 30d, Prime out -> RWA beats Harbor post-deposit
    expect(resp.venueHealth.find((h) => h.protocolId === 'ATLANTIC_PRIME')?.excludedFromRouting).toBe(true);
  });

  it('reverting RPC adapter failures are classified, never thrown', async () => {
    const chaos = new ChaosRegistry();
    chaos.setForced('PHAROS_RWA', 'RPC_REVERT', 'execution reverted');
    const agg = build(healthySpecs(), { timeoutMs: 300, failureThreshold: 99, cooldownMs: 10 }, chaos);
    const resp = await agg.handle({ text: 'Show my positions and current APY across all vaults', user: USER });
    expect(resp.ok).toBe(true);
    expect(resp.venueHealth.find((h) => h.protocolId === 'PHAROS_RWA')?.state).toBe('RPC_REVERT');
  });
});

describe('integration: two of three venues down', () => {
  it('portfolio + routing continue on the single healthy venue', async () => {
    const specs = healthySpecs();
    specs[2].snapshot = rwaSnapshot({ paused: true, pauseReason: 'drill' });
    const chaos = new ChaosRegistry();
    chaos.setForced('ATLANTIC_PRIME', 'TIMEOUT', 'drill');
    const agg = build(specs, { timeoutMs: 300, failureThreshold: 2, cooldownMs: 10_000 }, chaos);

    // Trip Prime's breaker.
    await agg.handle({ text: 'Compare yield rates', user: USER });
    await agg.handle({ text: 'Compare yield rates', user: USER });

    const query = await agg.handle({ text: 'Show my positions and current APY across all vaults', user: USER });
    expect(query.ok).toBe(true);
    expect(query.portfolio!.perVenue).toHaveLength(1);
    expect(query.degradedMode).toBe(true);

    const deposit = await agg.handle({ text: 'Deposit 300 USDC into the best yield vault', user: USER });
    expect(deposit.ok).toBe(true);
    expect(deposit.plan!.selectedProtocol).toBe('HARBOR_LEND'); // the only healthy venue
    expect(deposit.plan!.legs).toHaveLength(2);
    expect(deposit.banner).toContain('DEGRADED MODE');
  });

  it('all three down -> structured no-venue result, never a crash', async () => {
    const specs = healthySpecs().map((s) => ({ ...s, snapshot: { ...s.snapshot!, paused: true } }));
    const agg = build(specs);
    const resp = await agg.handle({ text: 'Deposit 500 USDC into the best yield vault', user: USER });
    expect(resp.ok).toBe(false);
    expect(resp.plan).toBeUndefined();
    expect(resp.rationale!.summary).toContain('No healthy venue');
  });
});

describe('integration: end-to-end commitment chain', () => {
  it('payload -> commitment -> verification closes the loop', async () => {
    const agg = build(healthySpecs());
    const resp = await agg.handle({ text: 'Deposit 500 USDC into the best yield vault', user: USER });
    const plan = resp.plan!;
    expect(plan.harborRouteCommitment).toMatch(/^0x[0-9a-f]{64}$/);
    // The approve leg is hashed into the runner-up commitments.
    expect(plan.legs[0].harborRouteCommitment).toBeNull();
    expect(plan.legs[1].harborRouteCommitment).toBe(plan.harborRouteCommitment);
    // Commitment is bound to the exact calldata the wallet must sign.
    expect(plan.legs[1].data.startsWith('0x')).toBe(true);
  });

  it('different amounts produce different route commitments', async () => {
    const agg = build(healthySpecs());
    const a = await agg.handle({ text: 'Deposit 500 USDC', user: USER });
    const b = await agg.handle({ text: 'Deposit 501 USDC', user: USER });
    expect(a.plan!.harborRouteCommitment).not.toBe(b.plan!.harborRouteCommitment);
  });

  it('venue address survives into every payload leg', async () => {
    const agg = build(healthySpecs());
    const resp = await agg.handle({ text: 'Deposit 500 USDC into the RWA treasury', user: USER });
    expect(resp.plan!.selectedVault).toBe(VAULTS.PHAROS_RWA);
    expect(resp.plan!.legs[1].to).toBe(VAULTS.PHAROS_RWA);
  });
});
