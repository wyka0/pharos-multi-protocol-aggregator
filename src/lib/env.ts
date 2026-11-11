/* ========================================================================== */
/* Server-side environment parsing.                                            */
/*                                                                            */
/* AIRGAP NOTE: this module intentionally exposes NO private key material.      */
/* The burnable testnet wallet key is consumed ONLY by scripts/ (deploy +      */
/* verification), never by src/ - the agent core is strictly non-custodial.    */
/* ========================================================================== */

import { PHAROS_CHAIN_ID } from './types';

export interface ServerEnv {
  rpcUrl: string;
  chainId: number;
  explorerUrl: string;
  phrsUsdPrice: number;
  suite: {
    address: string | null;
    tusdc: string | null;
    harborLend: string | null;
    primeStaking: string | null;
    rwaTreasury: string | null;
    routeAnchor: string | null;
  };
}

function readString(key: string): string | null {
  const v = process.env[key];
  return v && v.trim().length > 0 ? v.trim() : null;
}

export function getServerEnv(): ServerEnv {
  return {
    rpcUrl: readString('PHAROS_RPC_URL') ?? 'https://atlantic.dplabs-internal.com',
    chainId: Number(readString('PHAROS_CHAIN_ID') ?? PHAROS_CHAIN_ID),
    explorerUrl: readString('PHAROS_EXPLORER_URL') ?? 'https://atlantic.pharosscan.xyz',
    phrsUsdPrice: Number(readString('PHRS_USD_PRICE_USDC') ?? '2'),
    suite: {
      address: readString('PHAROS_SUITE_ADDRESS'),
      tusdc: readString('PHAROS_TUSDC_ADDRESS'),
      harborLend: readString('PHAROS_HARBOR_LEND_ADDRESS'),
      primeStaking: readString('PHAROS_ATLANTIC_PRIME_ADDRESS'),
      rwaTreasury: readString('PHAROS_RWA_TREASURY_ADDRESS'),
      routeAnchor: readString('PHAROS_ROUTE_ANCHOR_ADDRESS'),
    },
  };
}

export function isSuiteConfigured(env: ServerEnv): boolean {
  return Boolean(
    env.suite.address && env.suite.tusdc && env.suite.harborLend && env.suite.primeStaking && env.suite.rwaTreasury,
  );
}
