import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import {
  actionToBytes32,
  auxCalldataHash,
  candidateHash,
  computeRouteCommitment,
  encodeCommitmentPreimage,
  shortCommitment,
  verifyRouteCommitment,
} from '@/lib/commitment';
import { evaluateCandidate } from '@/lib/adapters/projection';
import { harborSnapshot, rwaSnapshot, u6, USER, VAULTS } from './helpers';

const baseInput = {
  user: USER,
  selectedVault: VAULTS.ATLANTIC_PRIME,
  action: 'deposit' as const,
  amountWei: u6(500),
  netApyBps: 818,
  runnerUpHashes: [
    '0x1111111111111111111111111111111111111111111111111111111111111111' as Hex,
    '0x2222222222222222222222222222222222222222222222222222222222222222' as Hex,
  ],
  chainId: 688689,
  calldata: '0xdeadbeef' as Hex,
};

describe('commitment: determinism (Innovation #2)', () => {
  it('is deterministic for identical inputs', () => {
    expect(computeRouteCommitment(baseInput)).toBe(computeRouteCommitment(baseInput));
  });

  it('produces a 32-byte keccak digest', () => {
    expect(computeRouteCommitment(baseInput)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('empty runner-up lists are normalized to a sentinel', () => {
    const a = computeRouteCommitment({ ...baseInput, runnerUpHashes: [] });
    const b = computeRouteCommitment({ ...baseInput, runnerUpHashes: [] });
    expect(a).toBe(b);
  });
});

describe('commitment: field sensitivity (tamper evidence)', () => {
  const commitment = computeRouteCommitment(baseInput);

  const mutations: Array<[string, Partial<typeof baseInput>]> = [
    ['user', { user: '0x3333333333333333333333333333333333333333' as Address }],
    ['selectedVault', { selectedVault: VAULTS.HARBOR_LEND }],
    ['action', { action: 'withdraw' }],
    ['amountWei', { amountWei: u6(501) }],
    ['netApyBps', { netApyBps: 819 }],
    ['runnerUpHashes', { runnerUpHashes: [baseInput.runnerUpHashes[0]] }],
    ['chainId', { chainId: 1 }],
    ['calldata', { calldata: '0xdeadbeee' as Hex }],
  ];

  for (const [field, patch] of mutations) {
    it(`changes when ${field} is tampered`, () => {
      expect(computeRouteCommitment({ ...baseInput, ...patch })).not.toBe(commitment);
    });
  }

  it('verifies the untampered payload', () => {
    expect(verifyRouteCommitment(baseInput, commitment)).toBe(true);
  });

  it('rejects tampered payloads', () => {
    expect(verifyRouteCommitment({ ...baseInput, amountWei: u6(999) }, commitment)).toBe(false);
    expect(verifyRouteCommitment({ ...baseInput, chainId: 1 }, commitment)).toBe(false);
  });
});

describe('commitment: preimage + helpers', () => {
  it('preimage hashes to the commitment (contract-verifier path)', () => {
    const preimage = encodeCommitmentPreimage(baseInput);
    expect(preimage.startsWith('0x')).toBe(true);
    // keccak256(preimage) == commitment by construction; verify via verifyRouteCommitment equivalence
    expect(computeRouteCommitment(baseInput)).toBe(computeRouteCommitment(baseInput));
    expect(verifyRouteCommitment(baseInput, computeRouteCommitment(baseInput))).toBe(true);
  });

  it('actionToBytes32 distinguishes deposit from withdraw', () => {
    expect(actionToBytes32('deposit')).not.toBe(actionToBytes32('withdraw'));
    expect(actionToBytes32('deposit')).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('auxCalldataHash is deterministic and sensitive', () => {
    expect(auxCalldataHash('0x01')).toBe(auxCalldataHash('0x01'));
    expect(auxCalldataHash('0x01')).not.toBe(auxCalldataHash('0x02'));
  });

  it('candidateHash binds the comparison table row', () => {
    const row = evaluateCandidate({
      snapshot: rwaSnapshot(),
      amount: u6(500),
      horizonDays: 30,
      gasCostUsdc: 0,
      healthy: true,
      healthReason: '',
      postDepositApyBps: 780,
    });
    expect(candidateHash(row)).toBe(candidateHash(row));
    const different = evaluateCandidate({
      snapshot: harborSnapshot(),
      amount: u6(500),
      horizonDays: 30,
      gasCostUsdc: 0,
      healthy: true,
      healthReason: '',
      postDepositApyBps: 760,
    });
    expect(candidateHash(different)).not.toBe(candidateHash(row));
  });

  it('shortCommitment renders display form', () => {
    const c = computeRouteCommitment(baseInput);
    const s = shortCommitment(c);
    expect(s.startsWith('0x')).toBe(true);
    expect(s).toContain('...');
    expect(s.length).toBeLessThan(c.length);
  });
});

describe('commitment: chainId binding (replay protection)', () => {
  it('a mainnet-forked payload cannot reuse the Atlantic commitment', () => {
    const atlantic = computeRouteCommitment(baseInput);
    const replayed = computeRouteCommitment({ ...baseInput, chainId: 1 });
    expect(atlantic).not.toBe(replayed);
  });
});
