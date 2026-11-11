import type { Address } from 'viem';
import type { AdapterResult, UserPosition, VenueSnapshot } from '../types';
import { AdapterRevertError } from '../errors';
import type { VaultReadClient } from './client-types';
import { assembleSnapshot, buildDepositCalldataFor, buildWithdrawCalldataFor, err, fetchUserPositionRaw, fetchVaultRawState, ok, readVault } from './shared';

/* ========================================================================== */
/* Protocol A adapter - HarborLendVault (ERC-4626 kinked utilization lending).  */
/*                                                                            */
/* Rate model (mirrors the on-chain contract exactly, all bps/yr):              */
/*   U = debtOwed / (cash + debtOwed)                                          */
/*   U <= 0.80 : rate = 200 + 1250 * U                                         */
/*   U >  0.80 : rate = 1200 + 94000 * (U - 0.80)                              */
/* Post-deposit: U' = debtOwed / (cash + debtOwed + dx) - supplying cash       */
/* LOWERS utilization and therefore the lender's post-deposit APY.             */
/* ========================================================================== */

export const HARBOR_PARAMS = {
  kinkUtilWad: 800_000_000_000_000_000n,
  baseBps: 200,
  slope1Bps: 1250,
  slope2Bps: 94_000,
  entryFeeBps: 0,
  exitFeeBps: 5,
} as const;

const WAD = 1_000_000_000_000_000_000n;

/** Pure kinked-utilization rate curve (bps/yr) for a given utilization. */
export function kinkedRateBps(utilWad: bigint): number {
  const { kinkUtilWad, baseBps, slope1Bps, slope2Bps } = HARBOR_PARAMS;
  if (utilWad <= kinkUtilWad) {
    return Number((BigInt(baseBps) * WAD + BigInt(slope1Bps) * utilWad) / WAD);
  }
  const baseAtKink = baseBps + (slope1Bps * Number(kinkUtilWad)) / Number(WAD);
  return Math.round(baseAtKink + (slope2Bps * Number(utilWad - kinkUtilWad)) / Number(WAD));
}

/** Pure post-deposit utilization: U' = debt / (cash + debt + dx). */
export function harborPostDepositUtilWad(model: { cash: bigint; debtOwed: bigint }, dx: bigint): bigint {
  const totalAfter = model.cash + model.debtOwed + dx;
  if (totalAfter === 0n) return 0n;
  return (model.debtOwed * WAD) / totalAfter;
}

/** Pure post-deposit APY projection for HarborLendVault. */
export function harborPostDepositApyBps(model: { cash: bigint; debtOwed: bigint }, dx: bigint): number {
  return kinkedRateBps(harborPostDepositUtilWad(model, dx));
}

export function createHarborLendAdapter(vaultAddress: Address, client: VaultReadClient) {
  const base = {
    protocolId: 'HARBOR_LEND' as const,
    label: 'HarborLendVault',
    archetype: 'ERC-4626 Kinked Utilization Lending',
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
        // TVL = total underlying managed by the vault (cash + virtual debt).
        const snapshot = assembleSnapshot(base, raw, { cash: raw.cash, debtOwed: raw.debtOwed }, raw.totalAssets);
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
      return harborPostDepositApyBps(snapshot.model, dx);
    },

    /** Live post-deposit APY straight from the chain (used by verification). */
    async livePostDepositApyBps(dx: bigint): Promise<number> {
      const v = await readVault<bigint>(client, vaultAddress, 'postDepositApyBps', [dx]);
      return Number(v);
    },

    /** Guard used in verification to surface revert reasons cleanly. */
    async assertRevert(message: string): Promise<never> {
      throw new AdapterRevertError(base.label, message);
    },
  };
}

export type HarborLendAdapter = ReturnType<typeof createHarborLendAdapter>;
