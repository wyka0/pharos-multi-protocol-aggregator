import { describe, expect, it } from 'vitest';
import { HARBOR_PARAMS, harborPostDepositApyBps, harborPostDepositUtilWad, kinkedRateBps } from '@/lib/adapters/harbor-lend';
import { createHarborLendAdapter } from '@/lib/adapters/harbor-lend';
import { buildDepositCalldataFor, buildWithdrawCalldataFor } from '@/lib/adapters/shared';
import { decodeFunctionData, type Address } from 'viem';
import { VAULT_ABI } from '@/lib/abis';
import { harborSnapshot, u6, USER, VAULTS } from './helpers';

const WAD = 1_000_000_000_000_000_000n;

describe('harbor-lend: kinked utilization rate curve', () => {
  it('returns the base rate at zero utilization', () => {
    expect(kinkedRateBps(0n)).toBe(HARBOR_PARAMS.baseBps);
  });
  it('slopes linearly below the kink (U=25% -> 512 bps)', () => {
    expect(kinkedRateBps(250_000_000_000_000_000n)).toBe(512);
  });
  it('matches the seeded state (U=37/82 -> 764 bps)', () => {
    expect(kinkedRateBps(451_219_512_195_121_951n)).toBe(764);
  });
  it('hits 1200 bps exactly at the kink (U=80%)', () => {
    expect(kinkedRateBps(800_000_000_000_000_000n)).toBe(1200);
  });
  it('steepens above the kink (U=90% -> 10600 bps per SLOPE2=94000)', () => {
    expect(kinkedRateBps(900_000_000_000_000_000n)).toBe(10_600);
  });
  it('reaches 20000 bps at full utilization', () => {
    const r = kinkedRateBps(WAD);
    expect(r).toBeGreaterThanOrEqual(19_000);
    expect(r).toBeLessThanOrEqual(20_000);
  });
  it('is monotonically increasing', () => {
    let prev = -1;
    for (let i = 0; i <= 20; i++) {
      const r = kinkedRateBps((BigInt(i) * WAD) / 20n);
      expect(r).toBeGreaterThanOrEqual(prev);
      prev = r;
    }
  });
});

describe('harbor-lend: post-deposit utilization model (Innovation #1)', () => {
  it('U-prime = debt / (cash + debt + dx) at the seeded state', () => {
    const model = { cash: u6(45_000), debtOwed: u6(37_000) };
    expect(harborPostDepositUtilWad(model, 0n)).toBe(451_219_512_195_121_951n);
  });
  it('deposits LOWER utilization (self-dilution)', () => {
    const model = { cash: u6(45_000), debtOwed: u6(37_000) };
    expect(harborPostDepositUtilWad(model, u6(500))).toBeLessThan(harborPostDepositUtilWad(model, 0n));
  });
  it('post-deposit APY drops from 764 to 760 bps for a 500 USDC deposit', () => {
    const model = { cash: u6(45_000), debtOwed: u6(37_000) };
    expect(harborPostDepositApyBps(model, 0n)).toBe(764);
    expect(harborPostDepositApyBps(model, u6(500))).toBe(760);
  });
  it('a whale deposit compresses APY to ~550 bps', () => {
    const model = { cash: u6(45_000), debtOwed: u6(37_000) };
    expect(harborPostDepositApyBps(model, u6(50_000))).toBe(550);
  });
  it('APY monotonically decreases as deposits grow', () => {
    const model = { cash: u6(45_000), debtOwed: u6(37_000) };
    let prev = Number.MAX_SAFE_INTEGER;
    for (const dx of [0, 100, 1_000, 5_000, 10_000, 50_000, 100_000]) {
      const r = harborPostDepositApyBps(model, u6(dx));
      expect(r).toBeLessThanOrEqual(prev);
      prev = r;
    }
  });
});

describe('harbor-lend: adapter snapshot + calldata (via stub client)', () => {
  const snapshot = harborSnapshot();

  const stubClient = {
    async readContract(args: { functionName: string }) {
      const map: Record<string, unknown> = {
        cash: snapshot.model.cash,
        debtOwed: snapshot.model.debtOwed,
        totalShares: snapshot.totalShares,
        totalAssets: snapshot.totalTvl,
        entryFeeBps: 0n,
        exitFeeBps: 5n,
        paused: false,
        pauseReason: '',
        utilizationWad: snapshot.utilizationWad,
        spotApyBps: BigInt(snapshot.spotApyBps),
        asset: snapshot.underlyingAddress,
        sharesOf: u6(500),
        principalOf: u6(497),
        convertToAssets: u6(500),
        maxWithdraw: u6(499),
      };
      return map[args.functionName];
    },
    async getBlockNumber() {
      return 100n;
    },
  };

  const adapter = createHarborLendAdapter(VAULTS.HARBOR_LEND, stubClient as never);

  it('exposes the unified adapter interface fields', () => {
    expect(adapter.protocolId).toBe('HARBOR_LEND');
    expect(adapter.label).toBe('HarborLendVault');
    expect(adapter.archetype).toContain('Kinked');
  });

  it('builds a snapshot with fee + utilization data', async () => {
    const res = await adapter.getSnapshot();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.spotApyBps).toBe(764);
    expect(res.data.entryFeeBps).toBe(0);
    expect(res.data.exitFeeBps).toBe(5);
    expect(res.data.availableLiquidity).toBe(u6(45_000));
    expect(res.data.paused).toBe(false);
  });

  it('returns null position for zero share balance', async () => {
    const empty = createHarborLendAdapter(VAULTS.HARBOR_LEND, {
      ...(stubClient as never),
      async readContract(args: { functionName: string }) {
        if (args.functionName === 'sharesOf') return 0n;
        const map: Record<string, unknown> = { principalOf: 0n, convertToAssets: 0n, maxWithdraw: 0n, spotApyBps: 764n, exitFeeBps: 5n };
        return map[args.functionName];
      },
    } as never);
    const res = await empty.getPosition(USER, true);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toBeNull();
  });

  it('returns a healthy position with liquidity-capped max withdrawable', async () => {
    const res = await adapter.getPosition(USER, true);
    expect(res.ok).toBe(true);
    if (!res.ok || !res.data) return;
    expect(res.data.underlyingValue).toBe(u6(500));
    expect(res.data.accruedYield).toBe(u6(3));
    expect(res.data.netApyBps).toBe(763); // 764 spot, 5 bps exit fee, floored
    expect(res.data.maxWithdrawable).toBe(u6(499));
  });

  it('classifies RPC failures as error results, not exceptions', async () => {
    const failing = createHarborLendAdapter(VAULTS.HARBOR_LEND, {
      async readContract() {
        throw new Error('execution reverted');
      },
      async getBlockNumber() {
        return 1n;
      },
    } as never);
    const res = await failing.getSnapshot();
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.kind).toBe('RPC_ERROR');
    expect(res.message).toContain('reverted');
  });

  it('encodes deposit(user, amount) calldata faithfully', () => {
    const calldata = adapter.buildDepositCalldata(u6(500), USER);
    expect(calldata.to).toBe(VAULTS.HARBOR_LEND);
    const decoded = decodeFunctionData({ abi: VAULT_ABI, data: calldata.data });
    expect(decoded.functionName).toBe('deposit');
    expect(decoded.args[0]).toBe(u6(500));
    expect(decoded.args[1]).toBe(USER);
  });

  it('encodes withdraw(netAmount, user) calldata faithfully', () => {
    const calldata = adapter.buildWithdrawCalldata(u6(200), USER);
    const decoded = decodeFunctionData({ abi: VAULT_ABI, data: calldata.data });
    expect(decoded.functionName).toBe('withdraw');
    expect(decoded.args[0]).toBe(u6(200));
    expect(decoded.args[1]).toBe(USER);
  });

  it('simulatePostDepositApy agrees with the pure model', () => {
    expect(adapter.simulatePostDepositApy(snapshot, u6(500))).toBe(harborPostDepositApyBps(snapshot.model, u6(500)));
  });

  it('shared calldata builders match adapter output', () => {
    expect(buildDepositCalldataFor(VAULTS.HARBOR_LEND, u6(1), USER)).toEqual(adapter.buildDepositCalldata(u6(1), USER));
    expect(buildWithdrawCalldataFor(VAULTS.HARBOR_LEND, u6(1), USER)).toEqual(adapter.buildWithdrawCalldata(u6(1), USER));
  });
});
