/* ========================================================================== */
/* The narrow client surface adapters actually need. viem's PublicClient       */
/* satisfies this structurally; tests inject stubs. Read-only by design -      */
/* adapters can never broadcast transactions (non-custodial airgap).           */
/* ========================================================================== */

import type { Abi, Address } from 'viem';

export interface ReadContractArgs {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}

export interface VaultReadClient {
  readContract(args: ReadContractArgs): Promise<unknown>;
  getBlockNumber(): Promise<bigint>;
}
