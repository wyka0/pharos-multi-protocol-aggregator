import { encodeFunctionData, type Address } from 'viem';
import { VAULT_ABI } from '../abis';
import type { AdapterFailureKind, AdapterResult, UserPosition, VenueSnapshot } from '../types';
import type { VaultReadClient } from './client-types';

/* ========================================================================== */
/* Shared adapter plumbing: on-chain reads -> typed AdapterResult values,      */
/* unsigned calldata builders, and snapshot assembly.                          */
/* ========================================================================== */

export type AdapterProtocolId = 'HARBOR_LEND' | 'ATLANTIC_PRIME' | 'PHAROS_RWA';

export interface AdapterBaseConfig {
  protocolId: AdapterProtocolId;
  label: string;
  archetype: string;
  vaultAddress: Address;
  client: VaultReadClient;
}

export function ok<T>(data: T, startedAt: number): AdapterResult<T> {
  return { ok: true, data, latencyMs: Date.now() - startedAt };
}

export function err(kind: AdapterFailureKind, message: string, startedAt: number): AdapterResult<never> {
  return { ok: false, kind, message, latencyMs: Date.now() - startedAt };
}

/** Read a view off the vault; rethrows raw errors for the caller to classify. */
export async function readVault<T>(
  client: VaultReadClient,
  vaultAddress: Address,
  functionName: string,
  args: readonly unknown[] = [],
): Promise<T> {
  return (await client.readContract({ address: vaultAddress, abi: VAULT_ABI, functionName, args })) as T;
}

export function buildDepositCalldataFor(vaultAddress: Address, amount: bigint, user: Address): { to: Address; data: `0x${string}` } {
  return {
    to: vaultAddress,
    data: encodeFunctionData({
      abi: VAULT_ABI,
      functionName: 'deposit',
      args: [amount, user],
    }),
  };
}

export function buildWithdrawCalldataFor(vaultAddress: Address, netAmount: bigint, user: Address): { to: Address; data: `0x${string}` } {
  return {
    to: vaultAddress,
    data: encodeFunctionData({
      abi: VAULT_ABI,
      functionName: 'withdraw',
      args: [netAmount, user],
    }),
  };
}

export interface VaultRawState {
  cash: bigint;
  debtOwed: bigint;
  totalShares: bigint;
  totalAssets: bigint;
  entryFeeBps: number;
  exitFeeBps: number;
  paused: boolean;
  pauseReason: string;
  utilizationWad: bigint;
  spotApyBps: number;
  asset: Address;
  blockNumber: bigint;
}

/** Fetch everything a vault snapshot needs (single round of parallel calls). */
export async function fetchVaultRawState(client: VaultReadClient, vaultAddress: Address): Promise<VaultRawState> {
  const [cash, debtOwed, totalShares, totalAssets, entryFeeBps, exitFeeBps, paused, pauseReason, utilizationWad, spotApyBps, asset, blockNumber] =
    await Promise.all([
      readVault<bigint>(client, vaultAddress, 'cash'),
      readVault<bigint>(client, vaultAddress, 'debtOwed'),
      readVault<bigint>(client, vaultAddress, 'totalShares'),
      readVault<bigint>(client, vaultAddress, 'totalAssets'),
      readVault<bigint>(client, vaultAddress, 'entryFeeBps'),
      readVault<bigint>(client, vaultAddress, 'exitFeeBps'),
      readVault<boolean>(client, vaultAddress, 'paused'),
      readVault<string>(client, vaultAddress, 'pauseReason'),
      readVault<bigint>(client, vaultAddress, 'utilizationWad'),
      readVault<bigint>(client, vaultAddress, 'spotApyBps'),
      readVault<Address>(client, vaultAddress, 'asset'),
      client.getBlockNumber(),
    ]);

  return {
    cash,
    debtOwed,
    totalShares,
    totalAssets,
    entryFeeBps: Number(entryFeeBps),
    exitFeeBps: Number(exitFeeBps),
    paused,
    pauseReason,
    utilizationWad,
    spotApyBps: Number(spotApyBps),
    asset,
    blockNumber,
  };
}

export async function fetchUserPositionRaw(
  client: VaultReadClient,
  vaultAddress: Address,
  user: Address,
  label: string,
  protocolId: AdapterProtocolId,
  healthy: boolean,
): Promise<UserPosition | null> {
  const shares = await readVault<bigint>(client, vaultAddress, 'sharesOf', [user]);
  if (shares === 0n) return null;

  const [principal, userAssets, maxNet, spotApy, exitFeeBps] = await Promise.all([
    readVault<bigint>(client, vaultAddress, 'principalOf', [user]),
    readVault<bigint>(client, vaultAddress, 'convertToAssets', [shares]),
    readVault<bigint>(client, vaultAddress, 'maxWithdraw', [user]),
    readVault<bigint>(client, vaultAddress, 'spotApyBps'),
    readVault<bigint>(client, vaultAddress, 'exitFeeBps'),
  ]);

  const exitFee = Number(exitFeeBps);
  const netApyBps = Math.floor((Number(spotApy) * (10_000 - exitFee)) / 10_000);

  return {
    protocolId,
    label,
    vaultAddress,
    shares,
    underlyingValue: userAssets,
    principalDeposited: principal,
    accruedYield: userAssets > principal ? userAssets - principal : 0n,
    netApyBps,
    maxWithdrawable: maxNet,
    healthy,
  };
}

export function assembleSnapshot(
  base: AdapterBaseConfig,
  raw: VaultRawState,
  model: VenueSnapshot['model'],
  totalTvl: bigint,
): VenueSnapshot {
  return {
    protocolId: base.protocolId,
    label: base.label,
    archetype: base.archetype,
    vaultAddress: base.vaultAddress,
    underlyingAddress: raw.asset,
    decimals: 6,
    spotApyBps: raw.spotApyBps,
    entryFeeBps: raw.entryFeeBps,
    exitFeeBps: raw.exitFeeBps,
    totalTvl,
    totalShares: raw.totalShares,
    availableLiquidity: raw.cash,
    utilizationWad: raw.utilizationWad,
    paused: raw.paused,
    pauseReason: raw.pauseReason.length > 0 ? raw.pauseReason : undefined,
    model,
    blockNumber: raw.blockNumber,
    observedAt: Date.now(),
  };
}
