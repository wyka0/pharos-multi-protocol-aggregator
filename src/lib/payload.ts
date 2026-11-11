import { encodeFunctionData, type Address, type Hex } from 'viem';
import { ERC20_ABI } from './abis';
import type { CandidateEvaluation, HarborActionPlan, HarborUnsignedPayload, RoutingRationale, WithdrawLegPlan } from './types';
import { PHAROS_CHAIN_ID } from './types';
import { auxCalldataHash, candidateHash, computeRouteCommitment, type RouteAction } from './commitment';
import type { GasPolicy } from './router';
import type { MeshAdapter } from './resilience';

/* ========================================================================== */
/* Non-custodial payload builder (Requirement 02).                             */
/*                                                                            */
/* Produces the Harbor confirmation card artifacts: human-readable summaries   */
/* plus raw ABI-encoded UNSIGNED transactions (to, data, value, chainId,       */
/* gasEstimate, harborRouteCommitment). No signing, no broadcasting, no key    */
/* material exists anywhere in this module - wallets execute these payloads.   */
/* ========================================================================== */

export interface DepositPlanBuildInput {
  user: Address;
  amount: bigint;
  horizonDays: number;
  selected: CandidateEvaluation;
  adapter: MeshAdapter;
  underlyingAddress: Address;
  gasPolicy: GasPolicy;
  rationale: RoutingRationale;
  candidates: CandidateEvaluation[];
  parsedFrom: string;
}

export function buildApproveLeg(underlyingAddress: Address, vaultAddress: Address, amount: bigint, gasPolicy: GasPolicy): HarborUnsignedPayload {
  const data = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [vaultAddress, amount],
  });
  return {
    kind: 'approve',
    to: underlyingAddress,
    data,
    value: '0',
    chainId: PHAROS_CHAIN_ID,
    gasEstimate: gasPolicy.approveGasUnits.toString(),
    harborRouteCommitment: null,
    humanSummary: `Approve ${vaultAddress} to pull ${amount.toString()} underlying units (6 decimals) from your wallet.`,
    amountRaw: amount.toString(),
  };
}

export function buildDepositPlan(input: DepositPlanBuildInput): HarborActionPlan {
  const { user, amount, horizonDays, selected, adapter, underlyingAddress, gasPolicy, rationale, candidates, parsedFrom } = input;

  const depositCalldata = adapter.buildDepositCalldata(amount, user);
  const approveLeg = buildApproveLeg(underlyingAddress, adapter.vaultAddress, amount, gasPolicy);

  const runnerUpHashes: Hex[] = [
    ...candidates.filter((c) => c.protocolId !== selected.protocolId).map((c) => candidateHash(c)),
    auxCalldataHash(approveLeg.data),
  ];

  const commitment = computeRouteCommitment({
    user,
    selectedVault: adapter.vaultAddress,
    action: 'deposit',
    amountWei: amount,
    netApyBps: selected.effectiveNetApyBps,
    runnerUpHashes,
    chainId: PHAROS_CHAIN_ID,
    calldata: depositCalldata.data,
  });

  const depositLeg: HarborUnsignedPayload = {
    kind: 'deposit',
    to: depositCalldata.to,
    data: depositCalldata.data,
    value: '0',
    chainId: PHAROS_CHAIN_ID,
    gasEstimate: gasPolicy.depositGasUnits.toString(),
    harborRouteCommitment: commitment,
    humanSummary: `Deposit ${amount.toString()} underlying units (6 decimals) into ${selected.label} via vault.deposit(uint256,address).`,
    amountRaw: amount.toString(),
  };

  return {
    action: 'deposit',
    user,
    amount,
    horizonDays,
    legs: [approveLeg, depositLeg],
    primaryLegIndex: 1,
    harborRouteCommitment: commitment,
    selectedVault: adapter.vaultAddress,
    selectedProtocol: selected.protocolId,
    rationale,
    createdAt: Date.now(),
    parsedFrom,
  };
}

export interface WithdrawPlanBuildInput {
  user: Address;
  amount: bigint;
  horizonDays: number;
  legs: WithdrawLegPlan[];
  adapters: readonly MeshAdapter[];
  gasPolicy: GasPolicy;
  rationale: RoutingRationale;
  comparisonTable: CandidateEvaluation[];
  parsedFrom: string;
}

export function buildWithdrawPlan(input: WithdrawPlanBuildInput): HarborActionPlan | null {
  const { user, amount, horizonDays, legs, adapters, gasPolicy, rationale, comparisonTable, parsedFrom } = input;
  if (legs.length === 0) return null;

  const primary = legs[0];
  const primaryAdapter = adapters.find((a) => a.vaultAddress.toLowerCase() === primary.vaultAddress.toLowerCase());
  if (!primaryAdapter) return null;

  const calldatas = legs.map((leg) => {
    const adapter = adapters.find((a) => a.vaultAddress.toLowerCase() === leg.vaultAddress.toLowerCase());
    if (!adapter) throw new Error(`no adapter for withdraw leg ${leg.label}`);
    return adapter.buildWithdrawCalldata(leg.netAmount, user);
  });

  const runnerUpHashes: Hex[] = [
    ...comparisonTable.filter((c) => c.protocolId !== primary.protocolId).map((c) => candidateHash(c)),
    ...calldatas.slice(1).map((c) => auxCalldataHash(c.data)),
  ];

  // Value-weighted net APY of the whole plan (used inside the commitment).
  const totalNet = legs.reduce((acc, l) => acc + l.netAmount, 0n);
  const weightedNetApy =
    totalNet === 0n
      ? 0
      : Math.round(legs.reduce((acc, l) => acc + l.fromNetApyBps * Number(l.netAmount), 0) / Number(totalNet));

  const commitment = computeRouteCommitment({
    user,
    selectedVault: primary.vaultAddress,
    action: 'withdraw',
    amountWei: amount,
    netApyBps: weightedNetApy,
    runnerUpHashes,
    chainId: PHAROS_CHAIN_ID,
    calldata: calldatas[0].data,
  });

  const payloadLegs: HarborUnsignedPayload[] = calldatas.map((c, i) => ({
    kind: 'withdraw' as const,
    to: c.to,
    data: c.data,
    value: '0',
    chainId: PHAROS_CHAIN_ID,
    gasEstimate: gasPolicy.withdrawGasUnits.toString(),
    harborRouteCommitment: commitment,
    humanSummary: `Withdraw ${legs[i].netAmount.toString()} underlying units (6 decimals, net of exit fees) from ${legs[i].label} into your wallet.`,
    amountRaw: legs[i].netAmount.toString(),
  }));

  return {
    action: 'withdraw',
    user,
    amount,
    horizonDays,
    legs: payloadLegs,
    primaryLegIndex: 0,
    harborRouteCommitment: commitment,
    selectedVault: primary.vaultAddress,
    selectedProtocol: primary.protocolId,
    rationale,
    createdAt: Date.now(),
    parsedFrom,
  };
}

/** Human-readable confirmation card for the UI / evidence transcripts. */
export function formatPlanConfirmationCard(plan: HarborActionPlan): string {
  const lines = [
    `HARBOR ${plan.action.toUpperCase()} PLAN (non-custodial, unsigned)`,
    `  User:           ${plan.user}`,
    `  Venue:          ${plan.selectedProtocol} @ ${plan.selectedVault}`,
    `  Amount:         ${plan.amount.toString()} underlying units (6 decimals)`,
    `  Horizon:        ${plan.horizonDays} days`,
    `  Legs:           ${plan.legs.length} (${plan.legs.map((l) => l.kind).join(' -> ')})`,
    `  Route proof:    ${plan.harborRouteCommitment}`,
    `  Chain:          Pharos Atlantic Testnet (${PHAROS_CHAIN_ID})`,
    '',
    '  Why this venue won:',
    `    ${plan.rationale.summary}`,
  ];
  return lines.join('\n');
}

export type { RouteAction };
