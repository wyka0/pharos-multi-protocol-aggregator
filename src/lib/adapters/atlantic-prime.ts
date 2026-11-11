import type { Address } from 'viem';
import type { AdapterResult, UserPosition, VenueSnapshot } from '../types';
import type { VaultReadClient } from './client-types';
import { assembleSnapshot, buildDepositCalldataFor, buildWithdrawCalldataFor, err, fetchUserPositionRaw, fetchVaultRawState, ok, readVault } from './shared';

/* ========================================================================== */
/* Protocol B adapter - AtlanticPrimeStaking (tiered staking vault).           */
/*                                                                            */
/* Rate model (mirrors the on-chain contract, bps/yr):                         */
/*   U = totalAssets / capacity                                                */
/*   rate = 940 * (1 - 0.35 * U^2)                                             */
/* 10 bps entry fee / 0 bps exit fee. Highest headline APY of the three        */
/* venues, but big deposits push U toward 1.0 and compress the effective rate  */
/* toward 611 bps - the whale-dilution effect the router must model.           */
/* ========================================================================== */

export const PRIME_PARAMS = {
  baseApyBps: 940,
  entryFeeBps: 10,
  exitFeeBps: 0,
  dilutionStrength: 0.35,
} as const;

const WAD = 1_000_000_000_000_000_000n;

/** Pure diluted rate (bps/yr) for post-action total assets vs capacity. */
export function primeDilutedApyBps(totalAssetsAfter: bigint, capacity: bigint): number {
  if (capacity === 0n) return PRIME_PARAMS.baseApyBps;
  const uWad = totalAssetsAfter >= capacity ? WAD : (totalAssetsAfter * WAD) / capacity;
  const u = Number(uWad) / Number(WAD);
  const dilution = 1 - PRIME_PARAMS.dilutionStrength * u * u;
  return Math.floor(PRIME_PARAMS.baseApyBps * dilution);
}

/** Pure post-deposit APY: U' = (totalAssets + dx) / capacity. */
export function primePostDepositApyBps(model: { cash: bigint; debtOwed: bigint; capacity?: bigint }, dx: bigint): number {
  const capacity = model.capacity ?? 0n;
  if (capacity === 0n) return PRIME_PARAMS.baseApyBps;
  return primeDilutedApyBps(model.cash + model.debtOwed + dx, capacity);
}

export function createAtlanticPrimeAdapter(vaultAddress: Address, client: VaultReadClient) {
  const base = {
    protocolId: 'ATLANTIC_PRIME' as const,
    label: 'AtlanticPrimeStaking',
    archetype: 'Tiered Yield-Bearing Staking (capacity-diluted)',
    vaultAddress,
    client,
  };

  return {
    protocolId: base.protocolId,
    label: base.label,
    archetype: base.archetype,
    vaultAddress,

    async getSnapshot(): Promise<AdapterResult<VenueSnapshot>> {
      const startedAt = Date.now();
      try {
        const raw = await fetchVaultRawState(client, vaultAddress);
        const capacity = await readVault<bigint>(client, vaultAddress, 'capacity');
        const snapshot = assembleSnapshot(base, raw, { cash: raw.cash, debtOwed: raw.debtOwed, capacity }, raw.totalAssets);
        return ok(snapshot, startedAt);
      } catch (e) {
        return err('RPC_ERROR', e instanceof Error ? e.message : String(e), startedAt);
      }
    },

    async getPosition(user: Address, healthy: boolean): Promise<AdapterResult<UserPosition | null>> {
      const startedAt = Date.now();
      try {
        const position = await fetchUserPositionRaw(client, vaultAddress, user, base.label, base.protocolId, healthy);
        return ok(position, startedAt);
      } catch (e) {
        return err('RPC_ERROR', e instanceof Error ? e.message : String(e), startedAt);
      }
    },

    buildDepositCalldata(amount: bigint, user: Address) {
      return buildDepositCalldataFor(vaultAddress, amount, user);
    },

    buildWithdrawCalldata(netAmount: bigint, user: Address) {
      return buildWithdrawCalldataFor(vaultAddress, netAmount, user);
    },

    simulatePostDepositApy(snapshot: VenueSnapshot, dx: bigint): number {
      return primePostDepositApyBps(snapshot.model, dx);
    },

    async livePostDepositApyBps(dx: bigint): Promise<number> {
      const v = await readVault<bigint>(client, vaultAddress, 'postDepositApyBps', [dx]);
      return Number(v);
    },
  };
}

export type AtlanticPrimeAdapter = ReturnType<typeof createAtlanticPrimeAdapter>;
