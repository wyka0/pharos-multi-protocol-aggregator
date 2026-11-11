/**
 * Deploys PharosVaultSuite (3 protocol vaults + route anchor + test underlying)
 * to Pharos Atlantic Testnet (chainId 688689) and seeds the ecosystem.
 *
 * Writes:
 *   - .env.local        PHAROS_*_ADDRESS entries (upsert)
 *   - evidence/deployment.json  deterministic deployment record
 *
 * Run: npm run compile && npm run deploy
 *
 * NOTE: scripts/ may hold keys (non-custodial airgap covers src/ only).
 */
import fs from 'node:fs';
import path from 'node:path';
import './env';
import { createPublicClient, createWalletClient, http, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { pharosAtlantic, explorerTx } from '../src/lib/chain';
import { SUITE_ABI } from '../src/lib/abis';
import { createThrottledReadClient, withRpcRetry, sleep } from '../src/lib/rpc';
import artifact from '../src/generated/suite.json';

const root = path.resolve(__dirname, '..');

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v || v.trim().length === 0) {
    console.error(`Missing ${key} in environment. Copy .env.example to .env.local first.`);
    process.exit(1);
  }
  return v.trim();
}

async function main() {
  const rpcUrl = requireEnv('PHAROS_RPC_URL');
  const chainId = Number(requireEnv('PHAROS_CHAIN_ID'));
  if (chainId !== 688689) {
    console.error(`Expected PHAROS_CHAIN_ID=688689 (Atlantic), got ${chainId}`);
    process.exit(1);
  }

  const pk = requireEnv('TEST_USER_PRIVATE_KEY');
  const account = privateKeyToAccount(pk as `0x${string}`);
  const publicClient = createPublicClient({ chain: pharosAtlantic, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain: pharosAtlantic, transport: http(rpcUrl) });

  const netId = await publicClient.getChainId();
  if (netId !== 688689) {
    console.error(`RPC chainId is ${netId}, expected 688689`);
    process.exit(1);
  }

  const balance = await publicClient.getBalance({ address: account.address });
  console.log(`Deployer ${account.address} balance ${Number(balance) / 1e18} PHRS`);
  if (balance === 0n) {
    console.error('Deployer wallet has zero PHRS - fund it from the Atlantic faucet first.');
    process.exit(1);
  }

  console.log('Deploying PharosVaultSuite (suite + 3 vaults + anchor in one constructor)...');
  const hash = await withRpcRetry(
    () =>
      walletClient.deployContract({
        abi: artifact.abi,
        bytecode: artifact.bytecode as `0x${string}`,
        args: [account.address],
        account,
      }),
    'deploy',
    { maxRetries: 6, baseDelayMs: 1_500 },
  );
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    console.error(`Deployment failed: ${explorerTx(hash)}`);
    process.exit(1);
  }
  const suiteAddress = receipt.contractAddress as Address;
  console.log(`PharosVaultSuite deployed at ${suiteAddress}`);
  console.log(`  tx: ${explorerTx(hash)}`);

  // Read derived addresses off the suite.
  const [tUSDC, harborLend, primeStaking, rwaTreasury, routeAnchor] = await Promise.all([
    publicClient.readContract({ address: suiteAddress, abi: SUITE_ABI, functionName: 'tUSDC' }),
    publicClient.readContract({ address: suiteAddress, abi: SUITE_ABI, functionName: 'harborLend' }),
    publicClient.readContract({ address: suiteAddress, abi: SUITE_ABI, functionName: 'primeStaking' }),
    publicClient.readContract({ address: suiteAddress, abi: SUITE_ABI, functionName: 'rwaTreasury' }),
    publicClient.readContract({ address: suiteAddress, abi: SUITE_ABI, functionName: 'routeAnchor' }),
  ]);

  console.log(`  HarborLendVault:      ${harborLend}`);
  console.log(`  AtlanticPrimeStaking: ${primeStaking}`);
  console.log(`  PharosRwaTreasury:    ${rwaTreasury}`);
  console.log(`  AggregatorRouteAnchor:${routeAnchor}`);
  console.log(`  SuiteToken (tUSDC):   ${tUSDC}`);

  // Upsert env entries.
  const envPath = path.join(root, '.env.local');
  const entries: Record<string, string> = {
    PHAROS_SUITE_ADDRESS: suiteAddress,
    PHAROS_TUSDC_ADDRESS: tUSDC,
    PHAROS_HARBOR_LEND_ADDRESS: harborLend,
    PHAROS_ATLANTIC_PRIME_ADDRESS: primeStaking,
    PHAROS_RWA_TREASURY_ADDRESS: rwaTreasury,
    PHAROS_ROUTE_ANCHOR_ADDRESS: routeAnchor,
  };
  let envText = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  for (const [k, v] of Object.entries(entries)) {
    const line = `${k}=${v}`;
    const re = new RegExp(`^${k}=.*$`, 'm');
    if (re.test(envText)) envText = envText.replace(re, line);
    else {
      envText = envText.replace(/^(# PHAROS_SUITE_ADDRESS=.*\n)/m, '');
      envText += `\n${line}`;
    }
  }
  fs.writeFileSync(envPath, envText.trimEnd() + '\n');
  console.log(`Updated ${path.relative(root, envPath)}`);

  // Deterministic deployment record (tracked evidence).
  const record = {
    network: 'Pharos Atlantic Testnet',
    chainId: 688689,
    rpcUrl,
    deployedAt: new Date().toISOString(),
    deployer: account.address,
    suiteAddress,
    contracts: {
      PharosVaultSuite: suiteAddress,
      HarborLendVault: harborLend,
      AtlanticPrimeStaking: primeStaking,
      PharosRwaTreasury: rwaTreasury,
      AggregatorRouteAnchor: routeAnchor,
      SuiteToken_tUSDC: tUSDC,
    },
    deployTx: hash,
    deployTxUrl: explorerTx(hash),
    blockNumber: Number(receipt.blockNumber),
    gasUsed: receipt.gasUsed.toString(),
  };
  const evidenceDir = path.join(root, 'evidence');
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, 'deployment.json'), `${JSON.stringify(record, null, 2)}\n`);
  console.log(`Evidence: ${path.join('evidence', 'deployment.json')}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
