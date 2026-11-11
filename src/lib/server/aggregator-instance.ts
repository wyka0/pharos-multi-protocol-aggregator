import { createPublicClient, http, type Address } from 'viem';
import { pharosAtlantic } from '../chain';
import { getServerEnv, isSuiteConfigured } from '../env';
import { createAdapterSuite } from '../adapters';
import { ResilientAdapterMesh } from '../resilience';
import { HarborAggregator, DEFAULT_AGGREGATOR_CONFIG } from '../aggregator';
import { createThrottledReadClient } from '../rpc';

/* ========================================================================== */
/* Server-side singleton: one mesh + aggregator per Next.js server process.    */
/* Built from PHAROS_* env (suite addresses written by `npm run deploy`).      */
/* Contains NO key material - the aggregator is read-only + payload-building.  */
/* ========================================================================== */

interface HarborServerState {
  aggregator: HarborAggregator | null;
  configError: string | null;
  chainId: number;
  rpcUrl: string;
}

const globalForHarbor = globalThis as unknown as { __harborServer?: HarborServerState };

export function getHarborServer(): HarborServerState {
  if (globalForHarbor.__harborServer) return globalForHarbor.__harborServer;

  const env = getServerEnv();
  if (!isSuiteConfigured(env)) {
    globalForHarbor.__harborServer = {
      aggregator: null,
      configError:
        'Suite not deployed/configured yet - run `npm run compile` and `npm run deploy` to deploy PharosVaultSuite and populate PHAROS_*_ADDRESS env entries.',
      chainId: env.chainId,
      rpcUrl: env.rpcUrl,
    };
    return globalForHarbor.__harborServer;
  }

  const rawClient = createPublicClient({ chain: pharosAtlantic, transport: http(env.rpcUrl) });
  const client = createThrottledReadClient(rawClient, { maxRequestsPerSecond: 6, maxRetries: 5 });
  const adapters = createAdapterSuite(
    {
      harborLend: env.suite.harborLend as Address,
      primeStaking: env.suite.primeStaking as Address,
      rwaTreasury: env.suite.rwaTreasury as Address,
    },
    client,
  );
  const mesh = new ResilientAdapterMesh(adapters, { timeoutMs: 30_000, failureThreshold: 3, cooldownMs: 30_000 });
  const aggregator = new HarborAggregator(mesh, {
    ...DEFAULT_AGGREGATOR_CONFIG,
    underlyingAddress: env.suite.tusdc as Address,
  });

  globalForHarbor.__harborServer = { aggregator, configError: null, chainId: env.chainId, rpcUrl: env.rpcUrl };
  return globalForHarbor.__harborServer;
}
