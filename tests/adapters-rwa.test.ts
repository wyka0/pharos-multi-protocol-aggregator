import { describe, expect, it } from 'vitest';
import { RWA_PARAMS, rwaPostDepositApyBps } from '@/lib/adapters/pharos-rwa';
import { createPharosRwaAdapter } from '@/lib/adapters/pharos-rwa';
import { rwaSnapshot, u6, USER, VAULTS } from './helpers';

describe('pharos-rwa: stable floor model', () => {
  it('uses the 780 bps floor with zero fees', () => {
    expect(RWA_PARAMS.floorApyBps).toBe(780);
    expect(RWA_PARAMS.entryFeeBps).toBe(0);
    expect(RWA_PARAMS.exitFeeBps).toBe(0);
  });

  it('rate is constant regardless of deposit size (zero slippage)', () => {
    expect(rwaPostDepositApyBps()).toBe(780);
  });

  it('deep liquidity snapshot survives any override', () => {
    expect(rwaSnapshot().spotApyBps).toBe(780);
    expect(rwaSnapshot({ model: { cash: u6(5_000_000), debtOwed: 0n } }).spotApyBps).toBe(780);
  });
});

describe('pharos-rwa: adapter behavior', () => {
  const snapshot = rwaSnapshot();
  const stubClient = {
    async readContract(args: { functionName: string }) {
      const map: Record<string, unknown> = {
        cash: u6(220_000),
        debtOwed: 0n,
        totalShares: u6(220_000),
        totalAssets: u6(220_000),
        entryFeeBps: 0n,
        exitFeeBps: 0n,
        paused: false,
        pauseReason: '',
        utilizationWad: 0n,
        spotApyBps: 780n,
        asset: snapshot.underlyingAddress,
        sharesOf: u6(500),
        principalOf: u6(500),
        convertToAssets: u6(500),
        maxWithdraw: u6(500),
      };
      return map[args.functionName];
    },
    async getBlockNumber() {
      return 100n;
    },
  };
  const adapter = createPharosRwaAdapter(VAULTS.PHAROS_RWA, stubClient as never);

  it('exposes the unified interface fields', () => {
    expect(adapter.protocolId).toBe('PHAROS_RWA');
    expect(adapter.label).toBe('PharosRwaTreasury');
    expect(adapter.archetype).toContain('RWA');
  });

  it('builds a snapshot with deep liquidity', async () => {
    const res = await adapter.getSnapshot();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.spotApyBps).toBe(780);
    expect(res.data.availableLiquidity).toBe(u6(220_000));
    expect(res.data.utilizationWad).toBe(0n);
  });

  it('surfaces the on-chain paused flag for the circuit breaker', async () => {
    const pausedClient = {
      ...(stubClient as never),
      async readContract(args: { functionName: string }) {
        if (args.functionName === 'paused') return true;
        if (args.functionName === 'pauseReason') return 'chaos-drill';
        return (stubClient as never as { readContract: (a: never) => unknown }).readContract(args as never);
      },
    };
    const pausedAdapter = createPharosRwaAdapter(VAULTS.PHAROS_RWA, pausedClient as never);
    const res = await pausedAdapter.getSnapshot();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.paused).toBe(true);
    expect(res.data.pauseReason).toBe('chaos-drill');
  });

  it('getPosition reports zero fees on exit', async () => {
    const res = await adapter.getPosition(USER, true);
    expect(res.ok).toBe(true);
    if (!res.ok || !res.data) return;
    expect(res.data.netApyBps).toBe(780);
  });

  it('fails gracefully on RPC errors', async () => {
    const failing = createPharosRwaAdapter(VAULTS.PHAROS_RWA, {
      async readContract() {
        throw new Error('nonce too low');
      },
      async getBlockNumber() {
        return 1n;
      },
    } as never);
    const res = await failing.getSnapshot();
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.kind).toBe('RPC_ERROR');
    expect(res.message).toContain('nonce');
  });

  it('simulatePostDepositApy ignores size entirely', () => {
    expect(adapter.simulatePostDepositApy(snapshot, u6(500))).toBe(780);
    expect(adapter.simulatePostDepositApy(snapshot, u6(50_000))).toBe(780);
    expect(adapter.simulatePostDepositApy(snapshot, u6(5_000_000))).toBe(780);
  });
});
