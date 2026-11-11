import type { Address } from 'viem';
import type { AdapterResult, UserPosition, VenueSnapshot } from '../types';
import type { VaultReadClient } from './client-types';
import { assembleSnapshot, buildDepositCalldataFor, buildWithdrawCalldataFor, err, fetchUserPositionRaw, fetchVaultRawState, ok, readVault } from './shared';

/* ========================================================================== */
/* Protocol C adapter - PharosRwaTreasury (institutional RWA T-Bill vault).    */
/*                                                                            */
/* Stable floor APY (780 bps), 0/0 fees, deep liquidity (zero utilization      */
/* slippage on any size) and an explicit on-chain paused / circuit-breaker     */
/* state. This is the venue the fault-isolation drill pauses on-chain; the     */
/* adapter still returns its snapshot (with paused=true) so the UI can show    */
/* the circuit-breaker state while routing excludes it (Requirement 04).       */
/* ========================================================================== */

export const RWA_PARAMS = {
  floorApyBps: 780,
  entryFeeBps: 0,
  exitFeeBps: 0,
} as const;

/** Pure constant-floor APY - zero slippage regardless of deposit size. */
export function rwaPostDepositApyBps(): number {
  return RWA_PARAMS.floorApyBps;
}

export function createPharosRwaAdapter(vaultAddress: Address, client: VaultReadClient) {
  const base = {
    protocolId: 'PHAROS_RWA' as const,
    label: 'PharosRwaTreasury',
    archetype: 'Institutional RWA T-Bill (stable floor, deep liquidity)',
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

    simulatePostDepositApy(_snapshot: VenueSnapshot, _dx: bigint): number {
      return rwaPostDepositApyBps();
    },

    async livePostDepositApyBps(dx: bigint): Promise<number> {
      const v = await readVault<bigint>(client, vaultAddress, 'postDepositApyBps', [dx]);
      return Number(v);
    },
  };
}

export type PharosRwaAdapter = ReturnType<typeof createPharosRwaAdapter>;
