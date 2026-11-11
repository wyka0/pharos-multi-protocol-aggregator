import type { Address } from 'viem';
import type { AdapterResult, ProtocolId, UserPosition, VenueSnapshot } from '../types';

/* ========================================================================== */
/* IVaultAdapter - the standardized interface every protocol is wrapped in.     */
/* (Requirement 01: 3 distinct on-chain protocols behind ONE unified interface) */
/*                                                                            */
/* Contract:                                                                   */
/*   - getSnapshot()          : live rates / TVL / liquidity / fees / U.       */
/*   - getPosition(user)      : shares, underlying value, accrued yield, net   */
/*                              APY, liquidity-constrained max withdrawable.   */
/*   - build*Calldata()       : raw ABI-encoded UNSIGNED calldata. Adapters    */
/*     contain no wallet, no key material, and no broadcast path (airgap).     */
/*   - simulatePostDepositApy() : pure post-deposit utilization model used by  */
/*     the horizon-aware VenueScoringEngine (Innovation #1).                   */
/*   All async methods return AdapterResult<T> so failures are VALUES, never  */
/*   exceptions crossing the resilient-mesh boundary (Requirement 04).         */
/* ========================================================================== */

export interface IVaultAdapter {
  readonly protocolId: ProtocolId;
  readonly label: string;
  readonly archetype: string;
  readonly vaultAddress: Address;

  getSnapshot(): Promise<AdapterResult<VenueSnapshot>>;

  /** Returns data(null) when the user holds no position in this vault. */
  getPosition(user: Address, healthy: boolean): Promise<AdapterResult<UserPosition | null>>;

  buildDepositCalldata(amount: bigint, user: Address): { to: Address; data: `0x${string}` };
  buildWithdrawCalldata(netAmount: bigint, user: Address): { to: Address; data: `0x${string}` };

  /** Pure model: instantaneous APY (bps) after absorbing `dx` underlying. */
  simulatePostDepositApy(snapshot: VenueSnapshot, dx: bigint): number;
}
