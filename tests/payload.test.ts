import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { ERC20_ABI, VAULT_ABI } from '@/lib/abis';
import { decodeFunctionData } from 'viem';
import { buildApproveLeg, buildDepositPlan, buildWithdrawPlan, formatPlanConfirmationCard } from '@/lib/payload';
import { DEFAULT_GAS_POLICY } from '@/lib/router';
import { computeRouteCommitment, candidateHash, auxCalldataHash } from '@/lib/commitment';
import { evaluateCandidate } from '@/lib/adapters/projection';
import type { CandidateEvaluation, RoutingRationale } from '@/lib/types';
import { harborSnapshot, primeSnapshot, rwaSnapshot, seededSnapshots, u6, USER, VAULTS } from './helpers';
import { mockAdapter } from './helpers';

function rationaleFor(candidates: CandidateEvaluation[], horizonDays = 30): RoutingRationale {
  const selected = candidates.find((c) => c.selected);
  return {
    action: 'deposit',
    summary: 'Selected AtlanticPrimeStaking (test rationale).',
    selected: selected?.protocolId ?? null,
    comparisonTable: candidates,
    runnerUps: [],
    degradedMode: false,
    degradedNotes: [],
    horizonDays,
    amountDisplay: '500.00 USDC',
    venueHealth: [],
  };
}

function primeSelectedRow(): CandidateEvaluation[] {
  const snapshots = seededSnapshots();
  const rows = [harborSnapshot(), primeSnapshot(), rwaSnapshot()].map((s, i) =>
    evaluateCandidate({
      snapshot: s,
      amount: u6(500),
      horizonDays: 30,
      gasCostUsdc: 0.02,
      healthy: true,
      healthReason: '',
      postDepositApyBps: [760, 929, 780][i],
    }),
  );
  rows[1].selected = true;
  return rows;
}

describe('payload: deposit plan assembly (non-custodial)', () => {
  const adapters = [mockAdapter({ snapshot: harborSnapshot() }), mockAdapter({ snapshot: primeSnapshot() }), mockAdapter({ snapshot: rwaSnapshot() })];
  const candidates = primeSelectedRow();
  const plan = buildDepositPlan({
    user: USER,
    amount: u6(500),
    horizonDays: 30,
    selected: candidates[1],
    adapter: adapters[1],
    underlyingAddress: '0xbbbb000000000000000000000000000000000001' as Address,
    gasPolicy: DEFAULT_GAS_POLICY,
    rationale: rationaleFor(candidates),
    candidates,
    parsedFrom: 'Deposit 500 USDC into the best yield vault',
  });

  it('produces exactly two legs: approve then deposit', () => {
    expect(plan.legs).toHaveLength(2);
    expect(plan.legs[0].kind).toBe('approve');
    expect(plan.legs[1].kind).toBe('deposit');
    expect(plan.primaryLegIndex).toBe(1);
  });

  it('approve leg targets the underlying token with the vault as spender', () => {
    const leg = plan.legs[0];
    expect(leg.to.toLowerCase()).toBe('0xbbbb000000000000000000000000000000000001');
    const decoded = decodeFunctionData({ abi: ERC20_ABI, data: leg.data });
    expect(decoded.functionName).toBe('approve');
    expect(String(decoded.args[0]).toLowerCase()).toBe(VAULTS.ATLANTIC_PRIME.toLowerCase());
    expect(decoded.args[1]).toBe(u6(500));
  });

  it('deposit leg targets the vault with deposit(amount, user)', () => {
    const leg = plan.legs[1];
    expect(leg.to.toLowerCase()).toBe(VAULTS.ATLANTIC_PRIME.toLowerCase());
    const decoded = decodeFunctionData({ abi: VAULT_ABI, data: leg.data });
    expect(decoded.functionName).toBe('deposit');
    expect(decoded.args[0]).toBe(u6(500));
    expect(String(decoded.args[1]).toLowerCase()).toBe(USER.toLowerCase());
  });

  it('all legs are valueless (native value never leaves the wallet)', () => {
    for (const leg of plan.legs) expect(leg.value).toBe('0');
  });

  it('all legs pin chainId 688689', () => {
    for (const leg of plan.legs) expect(leg.chainId).toBe(688689);
  });

  it('carries the harborRouteCommitment only on the action leg', () => {
    expect(plan.legs[0].harborRouteCommitment).toBeNull();
    expect(plan.legs[1].harborRouteCommitment).toBe(plan.harborRouteCommitment);
  });

  it('commitment binds user, vault, action, amount, net APY, runner-ups, chainId and calldata', () => {
    const expected = computeRouteCommitment({
      user: USER,
      selectedVault: VAULTS.ATLANTIC_PRIME,
      action: 'deposit',
      amountWei: u6(500),
      netApyBps: candidates[1].effectiveNetApyBps,
      runnerUpHashes: [candidateHash(candidates[0]), candidateHash(candidates[2]), auxCalldataHash(plan.legs[0].data)],
      chainId: 688689,
      calldata: plan.legs[1].data,
    });
    expect(plan.harborRouteCommitment).toBe(expected);
  });

  it('includes gas estimates per leg', () => {
    expect(plan.legs[0].gasEstimate).toBe('60000');
    expect(plan.legs[1].gasEstimate).toBe('185000');
  });

  it('confirmation card renders human-readable details', () => {
    const card = formatPlanConfirmationCard(plan);
    expect(card).toContain('HARBOR DEPOSIT PLAN');
    expect(card).toContain('non-custodial, unsigned');
    expect(card).toContain(plan.harborRouteCommitment);
    expect(card).toContain('Why this venue won');
  });
});

describe('payload: withdraw plan assembly (single + split)', () => {
  const adapters = [mockAdapter({ snapshot: harborSnapshot() }), mockAdapter({ snapshot: primeSnapshot() })];

  const legs = [
    { protocolId: 'HARBOR_LEND' as const, label: 'HarborLendVault', vaultAddress: VAULTS.HARBOR_LEND, grossAmount: u6(500), netAmount: u6(500), fromNetApyBps: 763, opportunityCostPreserved: '$1.25' },
    { protocolId: 'ATLANTIC_PRIME' as const, label: 'AtlanticPrimeStaking', vaultAddress: VAULTS.ATLANTIC_PRIME, grossAmount: u6(300), netAmount: u6(300), fromNetApyBps: 930, opportunityCostPreserved: '$1.53' },
  ];

  const plan = buildWithdrawPlan({
    user: USER,
    amount: u6(800),
    horizonDays: 30,
    legs,
    adapters,
    gasPolicy: DEFAULT_GAS_POLICY,
    rationale: {
      action: 'withdraw',
      summary: 'Split withdrawal across 2 venues.',
      selected: 'HARBOR_LEND',
      comparisonTable: [],
      runnerUps: [],
      degradedMode: false,
      degradedNotes: [],
      horizonDays: 30,
      amountDisplay: '800.00 USDC',
      venueHealth: [],
    },
    comparisonTable: [],
    parsedFrom: 'Withdraw 800 USDC',
  });

  it('returns null for empty leg lists', () => {
    expect(
      buildWithdrawPlan({
        user: USER,
        amount: u6(100),
        horizonDays: 30,
        legs: [],
        adapters,
        gasPolicy: DEFAULT_GAS_POLICY,
        rationale: rationaleFor([]),
        comparisonTable: [],
        parsedFrom: 'x',
      }),
    ).toBeNull();
  });

  it('encodes per-leg net amounts', () => {
    expect(plan.legs[0].amountRaw).toBe(u6(500).toString());
    expect(plan.legs[1].amountRaw).toBe(u6(300).toString());
    const d0 = decodeFunctionData({ abi: VAULT_ABI, data: plan.legs[0].data });
    const d1 = decodeFunctionData({ abi: VAULT_ABI, data: plan.legs[1].data });
    expect(d0.functionName).toBe('withdraw');
    expect(d0.args[0]).toBe(u6(500));
    expect(d1.args[0]).toBe(u6(300));
    expect(plan.legs[0].to.toLowerCase()).toBe(VAULTS.HARBOR_LEND.toLowerCase());
    expect(plan.legs[1].to.toLowerCase()).toBe(VAULTS.ATLANTIC_PRIME.toLowerCase());
  });

  it('shares one plan-level commitment across all legs', () => {
    expect(plan.legs[0].harborRouteCommitment).toBe(plan.harborRouteCommitment);
    expect(plan.legs[1].harborRouteCommitment).toBe(plan.harborRouteCommitment);
  });

  it('commitment reflects the value-weighted net APY of the plan', () => {
    const weighted = Math.round((763 * 500 + 930 * 300) / 800);
    const expected = computeRouteCommitment({
      user: USER,
      selectedVault: VAULTS.HARBOR_LEND,
      action: 'withdraw',
      amountWei: u6(800),
      netApyBps: weighted,
      runnerUpHashes: [auxCalldataHash(plan.legs[1].data)],
      chainId: 688689,
      calldata: plan.legs[0].data,
    });
    expect(plan.harborRouteCommitment).toBe(expected);
  });

  it('withdraw legs need no approve (vault pays out of shares)', () => {
    expect(plan.legs.every((l) => l.kind === 'withdraw')).toBe(true);
  });
});
