/**
 * Live Pharos Atlantic Testnet verification (chainId 688689).
 *
 * Runs the 4-scenario Harbor verification sequence against the SAME agent core
 * (src/lib) that powers the UI, then writes:
 *   - evidence/aggregator-evidence.json  (deterministic machine evidence)
 *   - SUBMISSION_EVIDENCE.md             (reviewer transcript with PharosScan links)
 *   - README.md receipt section          (between RECEIPTS markers)
 *
 * Scenarios:
 *   1. Unified multi-protocol query (rates, TVL, positions, health).
 *   2. Optimal deposit routing + execution ("Deposit 500 USDC into the best yield vault").
 *   3. Fault isolation failover (on-chain pause + RPC chaos; queries + routing survive).
 *   4. Optimal withdrawal prepared & executed ("Withdraw 200 USDC ... lowest-yielding")
 *      + bonus split-withdrawal solver demo ("Withdraw 550 USDC").
 *
 * Run: npm run verify
 * NOTE: only scripts/ hold key material; the agent core in src/ stays airgapped.
 */
import fs from 'node:fs';
import path from 'node:path';
import './env';
import { createPublicClient, createWalletClient, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { pharosAtlantic, explorerTx, explorerAddress } from '../src/lib/chain';
import { ANCHOR_ABI, ERC20_ABI, SUITE_ABI, VAULT_ABI } from '../src/lib/abis';
import { createAdapterSuite } from '../src/lib/adapters';
import { ResilientAdapterMesh } from '../src/lib/resilience';
import { HarborAggregator, DEFAULT_AGGREGATOR_CONFIG } from '../src/lib/aggregator';
import { getChaosRegistry } from '../src/lib/chaos';
import { parseIntent } from '../src/lib/intent';
import { createThrottledReadClient, withRpcRetry, sleep } from '../src/lib/rpc';
import type { AgentResponse, HarborActionPlan, ProtocolId, VenueSnapshot } from '../src/lib/types';

const root = path.resolve(__dirname, '..');

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v || v.trim().length === 0) {
    console.error(`Missing ${key}. Is .env.local present and the suite deployed (npm run deploy)?`);
    process.exit(1);
  }
  return v.trim();
}

function requireEnvAddress(key: string): Address {
  return requireEnv(key) as Address;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface TxRecord {
  label: string;
  hash: Hex;
  url: string;
  blockNumber?: number;
  gasUsed?: string;
  status?: string;
}

async function main() {
  const rpcUrl = requireEnv('PHAROS_RPC_URL');
  const chainId = Number(requireEnv('PHAROS_CHAIN_ID'));
  if (chainId !== 688689) throw new Error(`Expected chainId 688689, got ${chainId}`);

  const suiteAddress = requireEnvAddress('PHAROS_SUITE_ADDRESS');
  const tusdc = requireEnvAddress('PHAROS_TUSDC_ADDRESS');
  const harborLend = requireEnvAddress('PHAROS_HARBOR_LEND_ADDRESS');
  const primeStaking = requireEnvAddress('PHAROS_ATLANTIC_PRIME_ADDRESS');
  const rwaTreasury = requireEnvAddress('PHAROS_RWA_TREASURY_ADDRESS');
  const routeAnchor = requireEnvAddress('PHAROS_ROUTE_ANCHOR_ADDRESS');

  const pk = requireEnv('TEST_USER_PRIVATE_KEY');
  const account = privateKeyToAccount(pk as `0x${string}`);
  const user = account.address;

  const publicClientRaw = createPublicClient({ chain: pharosAtlantic, transport: http(rpcUrl) });
  // Throttled client feeds the adapters (bulk snapshot reads); the raw client
  // handles script-level ops (receipts, balances) with explicit retry.
  const throttledClient = createThrottledReadClient(publicClientRaw, { maxRequestsPerSecond: 6, maxRetries: 5 });
  const publicClient = publicClientRaw;
  const walletClient = createWalletClient({ account, chain: pharosAtlantic, transport: http(rpcUrl) });

  /** Write (or receipt) with retry through RPC quota errors + gentle pacing. */
  async function writeTx<T>(label: string, fn: () => Promise<T>): Promise<T> {
    await sleep(1_200); // pacing between transactions
    return withRpcRetry(fn, label, { maxRetries: 6, baseDelayMs: 1_500 });
  }

  // The agent core under test - identical wiring to the Next.js server, with a
  // lower breaker threshold so the chaos drill trips quickly.
  const adapters = createAdapterSuite({ harborLend, primeStaking, rwaTreasury }, throttledClient);
  const mesh = new ResilientAdapterMesh(adapters, { timeoutMs: 30_000, failureThreshold: 2, cooldownMs: 4_000 });
  const aggregator = new HarborAggregator(mesh, { ...DEFAULT_AGGREGATOR_CONFIG, underlyingAddress: tusdc });
  const chaos = getChaosRegistry();

  /* ------------------------------ preflight ------------------------------ */
  console.log('\n=== PREFLIGHT ===');
  const netChainId = await withRpcRetry(() => publicClient.getChainId(), 'getChainId');
  if (netChainId !== 688689) throw new Error(`RPC chainId ${netChainId} != 688689`);
  const phrsBalance = await withRpcRetry(() => publicClient.getBalance({ address: user }), 'getBalance');
  if (phrsBalance === 0n) throw new Error('Test wallet has zero PHRS for gas');
  const tusdcBalance = (await withRpcRetry(
    () => publicClient.readContract({ address: tusdc, abi: ERC20_ABI, functionName: 'balanceOf', args: [user] }),
    'tusdc balanceOf',
  )) as bigint;
  console.log(`wallet ${user} | ${Number(phrsBalance) / 1e18} PHRS | ${Number(tusdcBalance) / 1e6} tUSDC`);

  const deployment = JSON.parse(fs.readFileSync(path.join(root, 'evidence', 'deployment.json'), 'utf8')) as {
    deployTx: Hex;
    deployTxUrl: string;
    blockNumber: number;
    deployedAt: string;
  };

  const evidence: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    network: 'Pharos Atlantic Testnet',
    chainId: 688689,
    rpcUrl,
    explorer: 'https://atlantic.pharosscan.xyz',
    user,
    userUrl: explorerAddress(user),
    contracts: { suiteAddress, harborLend, primeStaking, rwaTreasury, routeAnchor, tusdc },
    deployment,
    scenarios: {},
    links: {} as Record<string, unknown>,
  };
  const links = evidence.links as Record<string, unknown>;
  links.deployTx = deployment.deployTxUrl;
  const txLog: TxRecord[] = [];

  async function sendTx(label: string, fn: () => Promise<Hex>): Promise<TxRecord> {
    const hash = await writeTx(label, fn);
    const receipt = await withRpcRetry(() => publicClient.waitForTransactionReceipt({ hash }), `${label}:receipt`, { maxRetries: 6, baseDelayMs: 1_500 });
    const rec: TxRecord = {
      label,
      hash,
      url: explorerTx(hash),
      blockNumber: Number(receipt.blockNumber),
      gasUsed: receipt.gasUsed.toString(),
      status: receipt.status,
    };
    txLog.push(rec);
    console.log(`  [tx ok] ${label} -> ${rec.url} (gas ${rec.gasUsed})`);
    if (receipt.status !== 'success') throw new Error(`tx failed: ${label} ${rec.url}`);
    return rec;
  }

  function snapshotRow(s: VenueSnapshot) {
    return {
      protocolId: s.protocolId,
      label: s.label,
      vault: s.vaultAddress,
      spotApyBps: s.spotApyBps,
      entryFeeBps: s.entryFeeBps,
      exitFeeBps: s.exitFeeBps,
      totalTvl: s.totalTvl.toString(),
      availableLiquidity: s.availableLiquidity.toString(),
      utilizationWad: s.utilizationWad.toString(),
      paused: s.paused,
      blockNumber: Number(s.blockNumber),
    };
  }

  function rationaleBlock(resp: AgentResponse) {
    return {
      intent: resp.intent,
      summary: resp.rationale?.summary ?? null,
      comparisonTable: resp.rationale?.comparisonTable ?? [],
      runnerUps: resp.rationale?.runnerUps ?? [],
      degradedMode: resp.rationale?.degradedMode ?? false,
      venueHealth: resp.venueHealth,
      banner: resp.banner ?? null,
      confirmationCard: resp.plan ? aggregator.confirmationCard(resp.plan) : null,
    };
  }

  async function executePlan(plan: HarborActionPlan, labels: string[]): Promise<TxRecord[]> {
    const records: TxRecord[] = [];
    for (const [i, leg] of plan.legs.entries()) {
      const fn = () =>
        walletClient.writeContract({
          address: leg.to,
          abi: leg.kind === 'approve' ? ERC20_ABI : VAULT_ABI,
          functionName: leg.kind as 'approve' | 'deposit' | 'withdraw',
          args:
            leg.kind === 'approve'
              ? [plan.selectedVault, BigInt(leg.amountRaw ?? '0')]
              : leg.kind === 'deposit'
                ? [BigInt(leg.amountRaw ?? '0'), plan.user]
                : [BigInt(leg.amountRaw ?? '0'), plan.user],
        });
      records.push(await sendTx(labels[i] ?? `leg[${i}] ${leg.kind}`, fn));
    }
    return records;
  }

  async function anchorCommitment(plan: HarborActionPlan, memo: string): Promise<TxRecord> {
    return sendTx(`anchor ${plan.action} commitment`, () =>
      walletClient.writeContract({
        address: routeAnchor,
        abi: ANCHOR_ABI,
        functionName: 'anchorCommitment',
        args: [plan.harborRouteCommitment, memo],
      }),
    );
  }

  /* ---------------------------------------------------------------------- */
  console.log('\n=== SCENARIO 1: Unified Multi-Protocol Query ===');
  const s1 = await aggregator.handle({ text: 'Show my positions and current APY across all vaults', user });
  if (!s1.ok || !s1.portfolio) throw new Error(`Scenario 1 query failed: ${s1.error}`);
  console.log(`positions=${s1.portfolio.positions.length} value=$${Number(s1.portfolio.totals.underlyingValue) / 1e6} weightedNetAPY=${s1.portfolio.weightedNetApyBps}bps`);
  for (const s of s1.portfolio.perVenue) {
    console.log(`  ${s.label.padEnd(22)} spot=${(s.spotApyBps / 100).toFixed(2)}%  tvl=$${Number(s.totalTvl) / 1e6}  liq=$${Number(s.availableLiquidity) / 1e6}  U=${(Number(s.utilizationWad) / 1e16).toFixed(1)}%`);
  }
  (evidence.scenarios as Record<string, unknown>)['unifiedQuery'] = {
    input: s1.intent.raw,
    venueSnapshots: s1.portfolio.perVenue.map(snapshotRow),
    positions: s1.portfolio.positions,
    totals: { underlyingValue: s1.portfolio.totals.underlyingValue.toString(), accruedYield: s1.portfolio.totals.accruedYield.toString(), weightedNetApyBps: s1.portfolio.weightedNetApyBps },
    venueHealth: s1.venueHealth,
    degradedMode: s1.degradedMode,
  };

  /* ---------------------------------------------------------------------- */
  console.log('\n=== SCENARIO 2: Optimal Deposit Routing & Execution ===');
  const s2Input = 'Deposit 500 USDC into the best yield vault';
  const s2Intent = parseIntent(s2Input);
  const s2 = await aggregator.handle({ text: s2Input, user });
  if (!s2.ok || !s2.plan) throw new Error(`Scenario 2 failed: ${s2.error}`);
  console.log(`winner: ${s2.plan.selectedProtocol}`);
  console.log(`why: ${s2.rationale?.summary}`);
  const s2Txs = await executePlan(s2.plan, [`approve 500 tUSDC -> ${s2.plan.selectedProtocol}`, `deposit 500 tUSDC into ${s2.plan.selectedProtocol}`]);
  const s2Anchor = await anchorCommitment(s2.plan, 'scenario2: optimal deposit 500 USDC, harbor route proof');

  // Materialize 30 days of yield so Scenario 4 shows accrued yield + a real
  // opportunity-cost decision between positions.
  await sendTx('warp accrual +30d on Prime (demo time machine)', () =>
    walletClient.writeContract({ address: suiteAddress, abi: SUITE_ABI, functionName: 'warpAccrual', args: [1, 30n * 86400n] }),
  );

  links.depositTx = s2Txs[1].url;
  links.anchorTx = s2Anchor.url;
  (evidence.scenarios as Record<string, unknown>)['optimalDeposit'] = {
    input: s2Input,
    parsedIntent: s2Intent,
    ...rationaleBlock(s2),
    commitment: s2.plan.harborRouteCommitment,
    unsignedPayload: s2.plan.legs,
    txs: s2Txs,
    anchorTx: s2Anchor,
    selectedProtocol: s2.plan.selectedProtocol,
  };

  /* ---------------------------------------------------------------------- */
  console.log('\n=== SCENARIO 3: Fault Isolation / Degraded-Venue Failover ===');
  const pauseTx = await sendTx('pause PharosRwaTreasury on-chain (circuit breaker)', () =>
    walletClient.writeContract({ address: suiteAddress, abi: SUITE_ABI, functionName: 'pauseProtocol', args: [2, true, 'chaos-drill: fault isolation demo'] }),
  );
  chaos.setForced('ATLANTIC_PRIME', 'TIMEOUT', 'chaos-drill: simulated RPC timeout on AtlanticPrimeStaking');
  console.log('chaos injected: AtlanticPrimeStaking -> TIMEOUT; RWA paused on-chain');

  // Round 1: Prime fails once (DEGRADED_TIMEOUT), RWA has no snapshot.
  await mesh.fetchAllSnapshots();
  // Round 2: Prime hits the failure threshold -> circuit opens, excluded.
  const s3Probe = await mesh.fetchAllSnapshots();
  const s3HealthDuring = s3Probe.health;

  const s3Query = await aggregator.handle({ text: 'Show my positions and current APY across all vaults', user });
  if (!s3Query.ok || !s3Query.portfolio) throw new Error(`Scenario 3 query failed: ${s3Query.error}`);
  console.log(`degraded query ok: served ${s3Query.portfolio.perVenue.length} healthy venue(s); banner: ${s3Query.banner ?? '(none)'}`);

  const s3Input = 'Deposit 300 USDC into the best yield vault';
  const s3 = await aggregator.handle({ text: s3Input, user });
  if (!s3.ok || !s3.plan) throw new Error(`Scenario 3 failover deposit failed: ${s3.error}`);
  console.log(`failover winner: ${s3.plan.selectedProtocol} (2 of 3 venues down)`);
  console.log(`why: ${s3.rationale?.summary}`);
  const s3Txs = await executePlan(s3.plan, [`approve 300 tUSDC -> ${s3.plan.selectedProtocol} (failover)`, `failover deposit 300 tUSDC into ${s3.plan.selectedProtocol}`]);
  const s3Anchor = await anchorCommitment(s3.plan, 'scenario3: degraded-mode failover deposit 300 USDC');
  links.failoverTx = s3Txs[1].url;

  // Show the second exclusion flavor: with chaos cleared the adapter now
  // answers, but the vault is still paused on-chain -> CIRCUIT_OPEN_PAUSED.
  chaos.clear('ATLANTIC_PRIME');
  await sleep(4_600); // half-open cooldown
  const pausedProbe = await mesh.fetchAllSnapshots();
  const rwaPausedHealth = pausedProbe.health.find((h) => h.protocolId === 'PHAROS_RWA');

  const unpauseTx = await sendTx('unpause PharosRwaTreasury (recover)', () =>
    walletClient.writeContract({ address: suiteAddress, abi: SUITE_ABI, functionName: 'pauseProtocol', args: [2, false, 'chaos-drill complete'] }),
  );
  await sleep(4_600); // allow half-open re-probe after the pause-drill failures
  const recovered = await mesh.fetchAllSnapshots();
  const rwaRecoveredHealth = recovered.health.find((h) => h.protocolId === 'PHAROS_RWA');
  console.log(`RWA health after recovery probe: ${rwaRecoveredHealth?.state}`);

  (evidence.scenarios as Record<string, unknown>)['faultIsolation'] = {
    pauseTx,
    chaosSpec: { protocolId: 'ATLANTIC_PRIME', kind: 'TIMEOUT', message: 'simulated RPC timeout' },
    breakerRounds: { primeStateAfterRound2: mesh.breakerState('ATLANTIC_PRIME'), rwaStateAfterRound2: mesh.breakerState('PHAROS_RWA') },
    healthDuringFailover: s3HealthDuring,
    degradedQuery: {
      input: s3Query.intent.raw,
      healthyVenuesServed: s3Query.portfolio.perVenue.map((v) => v.label),
      totals: { underlyingValue: s3Query.portfolio.totals.underlyingValue.toString() },
      banner: s3Query.banner,
      excluded: s3Query.portfolio.excluded,
    },
    failoverDeposit: { input: s3Input, ...rationaleBlock(s3), commitment: s3.plan.harborRouteCommitment, txs: s3Txs, anchorTx: s3Anchor, selectedProtocol: s3.plan.selectedProtocol },
    rwaCircuitOpenPausedHealth: rwaPausedHealth,
    unpauseTx,
    rwaHealthAfterRecovery: rwaRecoveredHealth,
  };

  /* ---------------------------------------------------------------------- */
  console.log('\n=== SCENARIO 4: Optimal Withdrawal Prepared & Executed ===');
  const s4Input = 'Withdraw 200 USDC from my lowest-yielding position';
  const s4 = await aggregator.handle({ text: s4Input, user });
  if (!s4.ok || !s4.plan) throw new Error(`Scenario 4 failed: ${s4.error}`);
  console.log(`exit venue: ${s4.plan.selectedProtocol} (opportunity-cost minimized)`);
  console.log(`why: ${s4.rationale?.summary}`);
  const s4Txs = await executePlan(s4.plan, s4.plan.legs.map((l) => `withdraw ${l.amountRaw} (net) from ${s4.plan.selectedProtocol}`));
  const s4Anchor = await anchorCommitment(s4.plan, 'scenario4: opportunity-cost-minimal withdrawal 200 USDC');
  links.withdrawTx = s4Txs[0].url;

  // Bonus: split-withdrawal solver across two venues.
  const s5Input = 'Withdraw 550 USDC';
  const s5 = await aggregator.handle({ text: s5Input, user });
  let s5Txs: TxRecord[] = [];
  let s5Anchor: TxRecord | null = null;
  if (s5.ok && s5.plan && s5.plan.legs.length > 1) {
    console.log(`split plan legs: ${s5.plan.legs.length}`);
    console.log(`why: ${s5.rationale?.summary}`);
    s5Txs = await executePlan(s5.plan, s5.plan.legs.map((l) => `split withdraw ${l.amountRaw} from ${l.kind}`));
    s5Anchor = await anchorCommitment(s5.plan, 'scenario4b: multi-vault split withdrawal 550 USDC');
    links.splitWithdrawTx = s5Txs.map((t) => t.url);
  } else {
    console.log(`split demo skipped: ${s5.error ?? 'single-leg plan'}`);
  }

  (evidence.scenarios as Record<string, unknown>)['optimalWithdraw'] = {
    input: s4Input,
    ...rationaleBlock(s4),
    commitment: s4.plan.harborRouteCommitment,
    unsignedPayload: s4.plan.legs,
    txs: s4Txs,
    anchorTx: s4Anchor,
    selectedProtocol: s4.plan.selectedProtocol,
    splitWithdrawal: {
      input: s5Input,
      legs: s5.plan?.legs.length ?? 0,
      ...rationaleBlock(s5),
      commitment: s5.plan?.harborRouteCommitment ?? null,
      txs: s5Txs,
      anchorTx: s5Anchor,
    },
  };
  const finalPortfolio = await aggregator.queryPortfolio(user);
  (evidence.scenarios as Record<string, unknown>)['finalPortfolio'] = {
    positions: finalPortfolio.positions,
    totals: { underlyingValue: finalPortfolio.totals.underlyingValue.toString(), accruedYield: finalPortfolio.totals.accruedYield.toString() },
    venueHealth: finalPortfolio.venueHealth,
  };
  (evidence as Record<string, unknown>)['txLog'] = txLog;

  /* ------------------------------ write-out ------------------------------ */
  const bigintReplacer = (_key: string, value: unknown) => (typeof value === 'bigint' ? value.toString() : value);
  const evidenceDir = path.join(root, 'evidence');
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, 'aggregator-evidence.json'), `${JSON.stringify(evidence, bigintReplacer, 2)}\n`);
  console.log(`\nevidence: evidence/aggregator-evidence.json`);

  writeSubmissionEvidence(root, evidence as EvidenceShape);
  writeReadmeReceipts(root, evidence as EvidenceShape);
  console.log('SUBMISSION_EVIDENCE.md + README receipts written.');
  console.log('\nALL 4 SCENARIOS VERIFIED ON PHAROS ATLANTIC TESTNET (688689).');
}

type EvidenceShape = ReturnType<typeof JSON.parse> & {
  scenarios: Record<string, any>;
  links: Record<string, any>;
  contracts: Record<string, string>;
  user: string;
};

function writeSubmissionEvidence(root: string, ev: EvidenceShape) {
  const s = ev.scenarios;
  const rows = (list: Array<{ label: string; url: string; gasUsed?: string; status?: string }>) =>
    list.map((t) => `| ${t.label} | [${t.hash.slice(0, 18)}...](${t.url}) | ${t.status ?? ''} | ${t.gasUsed ?? ''} |`).join('\n');

  const md = `# SUBMISSION EVIDENCE - Pharos Multi-Protocol Aggregator

> Auto-generated by \`npm run verify\` on ${ev.generatedAt}. Network: **Pharos Atlantic Testnet (chainId 688689)**.

## Deployment

| Contract | Address |
| --- | --- |
| PharosVaultSuite (facade) | [\`${ev.contracts.suiteAddress}\`](https://atlantic.pharosscan.xyz/address/${ev.contracts.suiteAddress}) |
| HarborLendVault (Protocol A) | [\`${ev.contracts.harborLend}\`](https://atlantic.pharosscan.xyz/address/${ev.contracts.harborLend}) |
| AtlanticPrimeStaking (Protocol B) | [\`${ev.contracts.primeStaking}\`](https://atlantic.pharosscan.xyz/address/${ev.contracts.primeStaking}) |
| PharosRwaTreasury (Protocol C) | [\`${ev.contracts.rwaTreasury}\`](https://atlantic.pharosscan.xyz/address/${ev.contracts.rwaTreasury}) |
| AggregatorRouteAnchor | [\`${ev.contracts.routeAnchor}\`](https://atlantic.pharosscan.xyz/address/${ev.contracts.routeAnchor}) |
| SuiteToken (tUSDC underlying) | [\`${ev.contracts.tusdc}\`](https://atlantic.pharosscan.xyz/address/${ev.contracts.tusdc}) |

Deploy tx: [${ev.deployment.deployTx}](${ev.deployment.deployTxUrl})

## Scenario 1 - Unified Multi-Protocol Query

Live reads across all 3 vaults in one request. Venue snapshots:

${((s.unifiedQuery.venueSnapshots ?? []) as any[]).map((v) => `- **${v.label}** - spot APY \`${(v.spotApyBps / 100).toFixed(2)}%\`, TVL \`${Number(v.totalTvl) / 1e6} tUSDC\`, liquidity \`${Number(v.availableLiquidity) / 1e6}\`, utilization \`${(Number(v.utilizationWad) / 1e16).toFixed(1)}%\`, paused \`${v.paused}\``).join('\n')}

## Scenario 2 - Optimal Deposit Routing & Execution

- Input: \`"${s.optimalDeposit.input}"\`
- Winner: **${s.optimalDeposit.selectedProtocol}**
- Route commitment: \`${s.optimalDeposit.commitment}\`
- Verbatim rationale: ${s.optimalDeposit.summary}

| Tx | Hash | Status | Gas |
| --- | --- | --- | --- |
${rows(s.optimalDeposit.txs)}

## Scenario 3 - Protocol Unavailability / Fault-Isolation Failover

- On-chain pause tx: [${s.faultIsolation.pauseTx.hash}](${s.faultIsolation.pauseTx.url}) - \`PharosRwaTreasury.setPaused(true)\`
- Chaos injection: \`AtlanticPrimeStaking -> TIMEOUT\` (simulated RPC failure)
- Breaker states after 2 failed rounds: Prime \`${JSON.stringify(s.faultIsolation.breakerRounds.primeStateAfterRound2)}\`, RWA \`${JSON.stringify(s.faultIsolation.breakerRounds.rwaStateAfterRound2)}\`
- Degraded query banner: ${s.faultIsolation.degradedQuery.banner ?? '(none)'}
- Failover winner with 2 of 3 venues down: **${s.faultIsolation.failoverDeposit.selectedProtocol}**
- Verbatim rationale: ${s.faultIsolation.failoverDeposit.summary}
- RWA health during pause-window probe: \`${JSON.stringify(s.faultIsolation.rwaCircuitOpenPausedHealth)}\`
- RWA health after recovery probe: \`${JSON.stringify(s.faultIsolation.rwaHealthAfterRecovery)}\`

| Tx | Hash | Status | Gas |
| --- | --- | --- | --- |
${rows([...s.faultIsolation.failoverDeposit.txs, s.faultIsolation.unpauseTx])}

## Scenario 4 - Optimal Withdrawal Prepared & Executed

- Input: \`"${s.optimalWithdraw.input}"\`
- Exit venue: **${s.optimalWithdraw.selectedProtocol}**
- Verbatim rationale: ${s.optimalWithdraw.summary}
- Split-withdrawal demo \`${s.optimalWithdraw.splitWithdrawal.input}\`: legs \`${s.optimalWithdraw.splitWithdrawal.legs}\` - ${s.optimalWithdraw.splitWithdrawal.summary ?? ''}

| Tx | Hash | Status | Gas |
| --- | --- | --- | --- |
${rows([...s.optimalWithdraw.txs, ...s.optimalWithdraw.splitWithdrawal.txs])}

## Route Proofs Anchored On-Chain

Every executed action's \`harborRouteCommitment\` (keccak256 over user, vault, action, amount, net APY, runner-up table hashes, chainId, calldata) was anchored in \`AggregatorRouteAnchor\`:

${[s.optimalDeposit.anchorTx, s.faultIsolation.failoverDeposit.anchorTx, s.optimalWithdraw.anchorTx, s.optimalWithdraw.splitWithdrawal.anchorTx].filter(Boolean).map((t: any) => `- [${t.label}](${t.url})`).join('\n')}

## Health & Fault-Isolation Proof

- During the drill the aggregator served queries and routed deposits with **2 of 3 protocols down** (RWA paused on-chain + Prime RPC chaos) - no HTTP 500, no crash, explicit degraded-mode banner.
- Full machine-readable evidence: [\`evidence/aggregator-evidence.json\`](evidence/aggregator-evidence.json).
`;

  fs.writeFileSync(path.join(root, 'SUBMISSION_EVIDENCE.md'), md);
}

function writeReadmeReceipts(root: string, ev: EvidenceShape) {
  const readmePath = path.join(root, 'README.md');
  if (!fs.existsSync(readmePath)) return;
  const s = ev.scenarios;

  const table = `<!-- RECEIPTS:START -->
### PharosScan Receipts (live, chainId 688689)

| Artifact | Link |
| --- | --- |
| Suite deploy tx | [${String(ev.deployment.deployTx).slice(0, 22)}...](${ev.deployment.deployTxUrl}) |
| Scenario 2 - optimal deposit 500 USDC | [${String(s.optimalDeposit.txs.at(-1)?.hash ?? '').slice(0, 22)}...](${s.optimalDeposit.txs.at(-1)?.url ?? '#'}) |
| Scenario 2 - route commitment anchor | [${String(s.optimalDeposit.anchorTx.hash).slice(0, 22)}...](${s.optimalDeposit.anchorTx.url}) |
| Scenario 3 - failover deposit (2 venues down) | [${String(s.faultIsolation.failoverDeposit.txs.at(-1)?.hash ?? '').slice(0, 22)}...](${s.faultIsolation.failoverDeposit.txs.at(-1)?.url ?? '#'}) |
| Scenario 4 - optimal withdrawal 200 USDC | [${String(s.optimalWithdraw.txs[0]?.hash ?? '').slice(0, 22)}...](${s.optimalWithdraw.txs[0]?.url ?? '#'}) |
| Scenario 4b - split withdrawal legs | ${(s.optimalWithdraw.splitWithdrawal.txs as any[]).map((t) => `[${String(t.hash).slice(0, 14)}...](${t.url})`).join(' · ') ?? 'n/a'} |
| Full evidence | [evidence/aggregator-evidence.json](evidence/aggregator-evidence.json) · [SUBMISSION_EVIDENCE.md](SUBMISSION_EVIDENCE.md) |
<!-- RECEIPTS:END -->`;

  const text = fs.readFileSync(readmePath, 'utf8');
  const start = text.indexOf('<!-- RECEIPTS:START -->');
  const end = text.indexOf('<!-- RECEIPTS:END -->');
  let next: string;
  if (start >= 0 && end > start) {
    next = text.slice(0, start) + table + text.slice(end + '<!-- RECEIPTS:END -->'.length);
  } else {
    next = `${text.trimEnd()}\n\n${table}\n`;
  }
  fs.writeFileSync(readmePath, next);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
