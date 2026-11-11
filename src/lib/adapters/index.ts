import type { Address } from 'viem';
import type { VaultReadClient } from './client-types';
import { createAtlanticPrimeAdapter, type AtlanticPrimeAdapter } from './atlantic-prime';
import { createHarborLendAdapter, type HarborLendAdapter } from './harbor-lend';
import { createPharosRwaAdapter, type PharosRwaAdapter } from './pharos-rwa';
import type { IVaultAdapter } from './IVaultAdapter';

export type AggregatorAdapter = HarborLendAdapter | AtlanticPrimeAdapter | PharosRwaAdapter;

export function isAdapter(x: unknown): x is AggregatorAdapter {
  return (
    typeof x === 'object' &&
    x !== null &&
    'protocolId' in x &&
    ['HARBOR_LEND', 'ATLANTIC_PRIME', 'PHAROS_RWA'].includes(String((x as { protocolId: unknown }).protocolId))
  );
}

/** Build the full 3-protocol adapter mesh from suite deployment addresses. */
export function createAdapterSuite(
  vaults: { harborLend: Address; primeStaking: Address; rwaTreasury: Address },
  client: VaultReadClient,
): AggregatorAdapter[] {
  return [
    createHarborLendAdapter(vaults.harborLend, client),
    createAtlanticPrimeAdapter(vaults.primeStaking, client),
    createPharosRwaAdapter(vaults.rwaTreasury, client),
  ];
}

export { createAtlanticPrimeAdapter } from './atlantic-prime';
export { createHarborLendAdapter } from './harbor-lend';
export { createPharosRwaAdapter } from './pharos-rwa';
export { PRIME_PARAMS } from './atlantic-prime';
export { HARBOR_PARAMS, kinkedRateBps, harborPostDepositApyBps, harborPostDepositUtilWad } from './harbor-lend';
export { RWA_PARAMS, rwaPostDepositApyBps } from './pharos-rwa';
export type { IVaultAdapter } from './IVaultAdapter';
export type { VaultReadClient } from './client-types';
