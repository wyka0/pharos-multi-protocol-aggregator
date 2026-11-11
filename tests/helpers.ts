import type { Address } from 'viem';
import {
  buildDepositCalldataFor,
  buildWithdrawCalldataFor,
  type AdapterProtocolId,
} from '@/lib/adapters/shared';
import type {
  AdapterFailureKind,
  AdapterResult,
  ProtocolId,
  UserPosition,
  VenueHealthEntry,
  VenueSnapshot,
} from '@/lib/types';
import type { MeshAdapter } from '@/lib/resilience';

/* ========================================================================== */
/* Shared fixture factories. Values mirror the on-chain PharosVaultSuite seed: */
/*   Harbor: cash 45k, debt 37k  -> U ~ 45.1%  -> spot ~ 764 bps               */
/*   Prime : deposits 10k, cap 60k -> U ~ 16.7% -> spot ~ 930 bps (940 base)   */
/*   RWA   : 220k liquidity -> flat 780 bps                                    */
/* ========================================================================== */

export const USER = '0x1111111111111111111111111111111111111111' as Address;
export const USER2 = '0x2222222222222222222222222222222222222222' as Address;

export const VAULTS: Record<ProtocolId, Address> = {
  HARBOR_LEND: '0xaaaa000000000000000000000000000000000001' as Address,
  ATLANTIC_PRIME: '0xaaaa000000000000000000000000000000000002' as Address,
  PHAROS_RWA: '0xaaaa000000000000000000000000000000000003' as Address,
};

export const TUSDC = '0xbbbb000000000000000000000000000000000001' as Address;

const WAD = 1_000_000_000_000_000_000n;

export const u6 = (n: number): bigint => BigInt(Math.round(n * 1e6));

/* ------------------------------ snapshots --------------------------------- */

export function harborSnapshot(overrides: Partial<VenueSnapshot> = {}): VenueSnapshot {
  const cash = overrides.model?.cash ?? u6(45_000);
  const debtOwed = overrides.model?.debtOwed ?? u6(37_000);
  const totalTvl = cash + debtOwed;
  const utilizationWad = totalTvl === 0n ? 0n : (debtOwed * WAD) / totalTvl;
  const spotApyBps =
    utilizationWad <= 800_000_000_000_000_000n
      ? Number((200n * WAD + 1250n * utilizationWad) / WAD)
      : Math.round(1200 + 94_000 * (Number(utilizationWad - 800_000_000_000_000_000n) / 1e18));
  return {
    protocolId: 'HARBOR_LEND',
    label: 'HarborLendVault',
    archetype: 'ERC-4626 Kinked Utilization Lending',
    vaultAddress: VAULTS.HARBOR_LEND,
    underlyingAddress: TUSDC,
    decimals: 6,
    spotApyBps,
    entryFeeBps: 0,
    exitFeeBps: 5,
    totalTvl,
    totalShares: totalTvl,
    availableLiquidity: cash,
    utilizationWad,
    paused: false,
    model: { cash, debtOwed },
    blockNumber: 100n,
    observedAt: Date.now(),
    ...overrides,
  };
}

export function primeSnapshot(overrides: Partial<VenueSnapshot> = {}): VenueSnapshot {
  const cash = overrides.model?.cash ?? u6(10_000);
  const debtOwed = overrides.model?.debtOwed ?? 0n;
  const capacity = overrides.model?.capacity ?? u6(60_000);
  const totalTvl = cash + debtOwed;
  const utilizationWad = totalTvl >= capacity ? WAD : (totalTvl * WAD) / capacity;
  const u = Number(utilizationWad) / 1e18;
  const spotApyBps = Math.floor(940 * (1 - 0.35 * u * u));
  return {
    protocolId: 'ATLANTIC_PRIME',
    label: 'AtlanticPrimeStaking',
    archetype: 'Tiered Yield-Bearing Staking (capacity-diluted)',
    vaultAddress: VAULTS.ATLANTIC_PRIME,
    underlyingAddress: TUSDC,
    decimals: 6,
    spotApyBps,
    entryFeeBps: 10,
    exitFeeBps: 0,
    totalTvl,
    totalShares: totalTvl,
    availableLiquidity: cash,
    utilizationWad,
    paused: false,
    model: { cash, debtOwed, capacity },
    blockNumber: 100n,
    observedAt: Date.now(),
    ...overrides,
  };
}

export function rwaSnapshot(overrides: Partial<VenueSnapshot> = {}): VenueSnapshot {
  const cash = overrides.model?.cash ?? u6(220_000);
  const debtOwed = overrides.model?.debtOwed ?? 0n;
  return {
    protocolId: 'PHAROS_RWA',
    label: 'PharosRwaTreasury',
    archetype: 'Institutional RWA T-Bill (stable floor, deep liquidity)',
    vaultAddress: VAULTS.PHAROS_RWA,
    underlyingAddress: TUSDC,
    decimals: 6,
    spotApyBps: 780,
    entryFeeBps: 0,
    exitFeeBps: 0,
    totalTvl: cash + debtOwed,
    totalShares: cash + debtOwed,
    availableLiquidity: cash,
    utilizationWad: 0n,
    paused: false,
    model: { cash, debtOwed },
    blockNumber: 100n,
    observedAt: Date.now(),
    ...overrides,
  };
}

export function seededSnapshots(): VenueSnapshot[] {
  return [harborSnapshot(), primeSnapshot(), rwaSnapshot()];
}

export function healthyHealth(snapshots: VenueSnapshot[]): VenueHealthEntry[] {
  return snapshots.map((s) => ({
    protocolId: s.protocolId,
    label: s.label,
    state: s.paused ? 'CIRCUIT_OPEN_PAUSED' : 'HEALTHY',
    consecutiveFailures: 0,
    excludedFromRouting: s.paused,
    reason: s.paused ? 'Vault paused on-chain' : '',
    latencyMs: 5,
  }));
}

/* ------------------------------- positions -------------------------------- */

export function position(protocolId: ProtocolId, overrides: Partial<UserPosition> = {}): UserPosition {
  const base: Record<ProtocolId, Partial<UserPosition>> = {
    HARBOR_LEND: { label: 'HarborLendVault', vaultAddress: VAULTS.HARBOR_LEND, underlyingValue: u6(500), netApyBps: 763, maxWithdrawable: u6(499), accruedYield: u6(1) },
    ATLANTIC_PRIME: { label: 'AtlanticPrimeStaking', vaultAddress: VAULTS.ATLANTIC_PRIME, underlyingValue: u6(500), netApyBps: 930, maxWithdrawable: u6(500), accruedYield: u6(3) },
    PHAROS_RWA: { label: 'PharosRwaTreasury', vaultAddress: VAULTS.PHAROS_RWA, underlyingValue: u6(500), netApyBps: 780, maxWithdrawable: u6(500), accruedYield: u6(2) },
  };
  return {
    protocolId,
    shares: u6(500),
    underlyingValue: u6(500),
    principalDeposited: u6(497),
    accruedYield: u6(3),
    netApyBps: 800,
    maxWithdrawable: u6(500),
    healthy: true,
    ...base[protocolId],
    ...overrides,
  } as UserPosition;
}

/* ----------------------------- mock adapters ------------------------------ */

export interface MockAdapterSpec {
  snapshot?: VenueSnapshot;
  snapshotResult?: AdapterResult<VenueSnapshot>;
  position?: UserPosition | null;
  positionResult?: AdapterResult<UserPosition | null>;
  /** Delay each call by ms (for timeout tests). */
  delayMs?: number;
  /** Reject snapshot calls with this failure kind. */
  failWith?: AdapterFailureKind;
  failMessage?: string;
  protocolId?: ProtocolId;
}

export function mockAdapter(spec: MockAdapterSpec): MeshAdapter {
  const pid = (spec.protocolId ?? spec.snapshot?.protocolId ?? 'HARBOR_LEND') as ProtocolId;
  const vaultAddress = spec.snapshot?.vaultAddress ?? VAULTS[pid];
  const label = spec.snapshot?.label ?? pid;
  let snapshotCalls = 0;

  return {
    protocolId: pid,
    label,
    archetype: 'mock',
    vaultAddress,
    async getSnapshot(): Promise<AdapterResult<VenueSnapshot>> {
      snapshotCalls += 1;
      if (spec.delayMs) await new Promise((r) => setTimeout(r, spec.delayMs));
      if (spec.failWith) {
        return { ok: false, kind: spec.failWith, message: spec.failMessage ?? `mock ${spec.failWith}`, latencyMs: spec.delayMs ?? 0 };
      }
      if (spec.snapshotResult) return spec.snapshotResult;
      if (spec.snapshot) return { ok: true, data: spec.snapshot, latencyMs: 1 };
      return { ok: false, kind: 'RPC_ERROR', message: 'mock has no snapshot', latencyMs: 1 };
    },
    async getPosition(user: Address): Promise<AdapterResult<UserPosition | null>> {
      if (spec.delayMs) await new Promise((r) => setTimeout(r, spec.delayMs));
      if (user === '0x0000000000000000000000000000000000000000') {
        return { ok: true, data: null, latencyMs: 1 };
      }
      if (spec.failWith) {
        return { ok: false, kind: spec.failWith, message: spec.failMessage ?? `mock ${spec.failWith}`, latencyMs: 1 };
      }
      if (spec.positionResult) return spec.positionResult;
      return { ok: true, data: spec.position ?? null, latencyMs: 1 };
    },
    buildDepositCalldata(amount: bigint, user: Address) {
      return buildDepositCalldataFor(vaultAddress, amount, user);
    },
    buildWithdrawCalldata(netAmount: bigint, user: Address) {
      return buildWithdrawCalldataFor(vaultAddress, netAmount, user);
    },
    simulatePostDepositApy(snapshot: VenueSnapshot, dx: bigint): number {
      const model = snapshot.model;
      if (pid === 'HARBOR_LEND') {
        const totalAfter = model.cash + model.debtOwed + dx;
        const utilWad = totalAfter === 0n ? 0n : (model.debtOwed * WAD) / totalAfter;
        return utilWad <= 800_000_000_000_000_000n
          ? Number((200n * WAD + 1250n * utilWad) / WAD)
          : Math.round(1200 + 94_000 * (Number(utilWad - 800_000_000_000_000_000n) / 1e18));
      }
      if (pid === 'ATLANTIC_PRIME') {
        const capacity = model.capacity ?? 0n;
        if (capacity === 0n) return 940;
        const ta = model.cash + model.debtOwed + dx;
        const uWad = ta >= capacity ? WAD : (ta * WAD) / capacity;
        const u = Number(uWad) / 1e18;
        return Math.floor(940 * (1 - 0.35 * u * u));
      }
      return 780;
    },
  };
}

/** Adapter that throws raw (simulating transport-level crashes). */
export function throwingAdapter(pid: ProtocolId, error: Error): MeshAdapter {
  const inner = mockAdapter({ protocolId: pid, snapshot: harborSnapshot({ protocolId: pid }) });
  return {
    ...inner,
    async getSnapshot() {
      throw error;
    },
    async getPosition() {
      throw error;
    },
  };
}

/** Slow adapter used for per-adapter timeout tests. */
export function slowAdapter(pid: ProtocolId, delayMs: number): MeshAdapter {
  return mockAdapter({ protocolId: pid, snapshot: harborSnapshot({ protocolId: pid }), delayMs });
}

export type { AdapterProtocolId };
