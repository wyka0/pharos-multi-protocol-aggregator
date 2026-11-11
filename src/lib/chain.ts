import { defineChain } from 'viem';

/* ========================================================================== */
/* Pharos Atlantic Testnet chain definitions (viem + wagmi share this).        */
/* ========================================================================== */

export const pharosAtlantic = defineChain({
  id: 688689,
  name: 'Pharos Atlantic Testnet',
  nativeCurrency: { name: 'Pharos', symbol: 'PHRS', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://atlantic.dplabs-internal.com'] },
  },
  blockExplorers: {
    default: { name: 'PharosScan', url: 'https://atlantic.pharosscan.xyz' },
  },
  testnet: true,
});

export function explorerTx(txHash: string): string {
  return `https://atlantic.pharosscan.xyz/tx/${txHash}`;
}

export function explorerAddress(addr: string): string {
  return `https://atlantic.pharosscan.xyz/address/${addr}`;
}
