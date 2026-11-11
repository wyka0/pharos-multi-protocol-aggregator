import type { Address, Hex } from 'viem';

/* ========================================================================== */
/* Shared domain types for the Harbor Multi-Protocol Aggregator.              */
/* Pure types only - safe to import from both server and client code.         */
/* ========================================================================== */

export const PHAROS_CHAIN_ID = 688689 as const;

export const PHAROS_EXPLORER_URL = 'https://atlantic.pharosscan.xyz';

/** The three distinct on-chain protocols unified behind one interface. */
export type ProtocolId = 'HARBOR_LEND' | 'ATLANTIC_PRIME' | 'PHAROS_RWA';

export const PROTOCOL_IDS: readonly ProtocolId[] = ['HARBOR_LEND', 'ATLANTIC_PRIME', 'PHAROS_RWA'] as const;

export const PROTOCOL_LABELS: Record<ProtocolId, string> = {
  HARBOR_LEND: 'HarborLendVault',
  ATLANTIC_PRIME: 'AtlanticPrimeStaking',
  PHAROS_RWA: 'PharosRwaTreasury',
};

export type AdapterFailureKind = 'PAUSED' | 'TIMEOUT' | 'RPC_REVERT' | 'RPC_ERROR';

/** Fault-isolation states attached to every venue (Requirement 04). */
export type VaultHealthState =
  | 'HEALTHY'
  | 'DEGRADED_TIMEOUT'
  | 'CIRCUIT_OPEN_PAUSED'
  | 'CIRCUIT_OPEN'
  | 'RPC_REVERT'
  | 'RPC_ERROR';

/* ------------------------------ adapter results --------------------------- */

export interface AdapterOk<T> {
  ok: true;
  data: T;
  latencyMs: number;
}

export interface AdapterErr {
  ok: false;
  kind: AdapterFailureKind;
  message: string;
  latencyMs: number;
}

export type AdapterResult<T> = AdapterOk<T> | AdapterErr;

/* ------------------------------ venue snapshots --------------------------- */

/** Vault model state consumed by the routing math (underlying units). */
export interface VaultModelState {
  /** Idle underlying held by the vault = instant withdrawal liquidity. */
  cash: bigint;
  /** Virtual interest-bearing pool (borrower debt / reward pool). */
  debtOwed: bigint;
  /** Staking capacity (Protocol B only, undefined otherwise). */
  capacity?: bigint;
}

export interface VenueSnapshot {
  protocolId: ProtocolId;
  label: string;
  archetype: string;
  vaultAddress: Address;
  underlyingAddress: Address;
  decimals: number;
  /** Instantaneous gross APY in bps/year. */
  spotApyBps: number;
  entryFeeBps: number;
  exitFeeBps: number;
  /** Total value locked, in underlying units. */
  totalTvl: bigint;
  totalShares: bigint;
  /** Withdrawable idle liquidity, in underlying units. */
  availableLiquidity: bigint;
  /** Utilization in WAD (1e18). */
  utilizationWad: bigint;
  /** On-chain circuit-breaker state (Protocol C / suite pause drill). */
  paused: boolean;
  pauseReason?: string;
  model: VaultModelState;
  blockNumber: bigint;
  observedAt: number;
}

export interface UserPosition {
  protocolId: ProtocolId;
  label: string;
  vaultAddress: Address;
  shares: bigint;
  /** Current share price valued in underlying units. */
  underlyingValue: bigint;
  principalDeposited: bigint;
  accruedYield: bigint;
  /** Net spot APY for this position (post exit fee), bps/year. */
  netApyBps: number;
  /** Liquidity-constrained max net withdrawable right now. */
  maxWithdrawable: bigint;
  healthy: boolean;
}

/* --------------------------------- routing -------------------------------- */

export interface CandidateEvaluation {
  protocolId: ProtocolId;
  label: string;
  vaultAddress: Address;
  headlineApyBps: number;
  /** Modeled instantaneous APY after absorbing `amount` (bps). */
  postDepositApyBps: number;
  entryFeeBps: number;
  exitFeeBps: number;
  /** entryFeeBps * amount (underlying units). */
  entryFeeCost: bigint;
  /** Gross yield over horizon on fee-adjusted principal (underlying units). */
  grossYield: bigint;
  /** Modeled gas cost for the action, in USDC (float). */
  gasCostUsdc: number;
  /** The requirement-03 objective: grossYield - entryFeeCost - gasCost. */
  netExpectedYield: bigint;
  /** netExpectedYield annualized over the horizon (bps). */
  effectiveNetApyBps: number;
  utilizationBeforeWad: bigint;
  utilizationAfterWad: bigint;
  healthy: boolean;
  selected: boolean;
  rejectionReasons: string[];
}

export interface RunnerUpRejection {
  protocolId: ProtocolId;
  label: string;
  netExpectedYield: number;
  reason: string;
}

export interface VenueHealthEntry {
  protocolId: ProtocolId;
  label: string;
  state: VaultHealthState;
  consecutiveFailures: number;
  excludedFromRouting: boolean;
  reason: string;
  latencyMs: number | null;
}

export interface RoutingRationale {
  action: 'deposit' | 'withdraw' | 'query';
  /** Human-readable explanation in the requirement-03 example format. */
  summary: string;
  selected: ProtocolId | null;
  comparisonTable: CandidateEvaluation[];
  runnerUps: RunnerUpRejection[];
  degradedMode: boolean;
  degradedNotes: string[];
  horizonDays: number;
  amountDisplay: string;
  venueHealth: VenueHealthEntry[];
}

/* ------------------------------ unsigned payload -------------------------- */

export type PayloadKind = 'approve' | 'deposit' | 'withdraw';

/**
 * A fully prepared, ABI-encoded, UNSIGNED transaction. The agent core never
 * signs or broadcasts - wallets (or scripts/) do that (Requirement 02).
 */
export interface HarborUnsignedPayload {
  kind: PayloadKind;
  to: Address;
  data: Hex;
  value: '0';
  chainId: number;
  gasEstimate: string;
  /** Set on action legs; null on approve legs. */
  harborRouteCommitment: Hex | null;
  humanSummary: string;
  /** Underlying-unit amount (6 decimals) this leg moves, as decimal string. */
  amountRaw?: string;
}

export interface WithdrawLegPlan {
  protocolId: ProtocolId;
  label: string;
  vaultAddress: Address;
  grossAmount: bigint;
  netAmount: bigint;
  fromNetApyBps: number;
  opportunityCostPreserved: string;
}

export interface HarborActionPlan {
  action: 'deposit' | 'withdraw';
  user: Address;
  /** Total underlying moved by the plan (raw units). */
  amount: bigint;
  horizonDays: number;
  legs: HarborUnsignedPayload[];
  primaryLegIndex: number;
  harborRouteCommitment: Hex;
  selectedVault: Address;
  selectedProtocol: ProtocolId;
  rationale: RoutingRationale;
  createdAt: number;
  parsedFrom: string;
}

/* ---------------------------------- intent -------------------------------- */

export type VaultRef = 'best' | 'lowest-yield' | ProtocolId;

export type ParsedIntent =
  | { kind: 'query_portfolio'; raw: string; confidence: number; matched: string[] }
  | { kind: 'query_rates'; raw: string; horizonDays: number; confidence: number; matched: string[] }
  | {
      kind: 'deposit';
      raw: string;
      amount: number;
      horizonDays: number;
      target: VaultRef;
      confidence: number;
      matched: string[];
    }
  | {
      kind: 'withdraw';
      raw: string;
      amount: number;
      horizonDays: number;
      source: VaultRef;
      confidence: number;
      matched: string[];
    }
  | { kind: 'unknown'; raw: string; confidence: number; matched: string[]; hint: string };

export interface StructuredIntent {
  action: 'query_portfolio' | 'query_rates' | 'deposit' | 'withdraw';
  amount?: number;
  horizonDays?: number;
  target?: VaultRef;
  source?: VaultRef;
}

/* --------------------------------- queries -------------------------------- */

export interface PortfolioTotals {
  underlyingValue: bigint;
  accruedYield: bigint;
  positionsCount: number;
}

export interface PortfolioQueryResult {
  user: Address | null;
  positions: UserPosition[];
  totals: PortfolioTotals;
  perVenue: VenueSnapshot[];
  /** Value-weighted net APY across healthy positions (bps). */
  weightedNetApyBps: number;
  excluded: VenueHealthEntry[];
}

export interface RatesComparison {
  horizonDays: number;
  venues: Array<{
    protocolId: ProtocolId;
    label: string;
    archetype: string;
    spotApyBps: number;
    entryFeeBps: number;
    exitFeeBps: number;
    totalTvl: bigint;
    availableLiquidity: bigint;
    utilizationWad: bigint;
    healthy: boolean;
  }>;
  excluded: VenueHealthEntry[];
}

/* -------------------------------- agent IO -------------------------------- */

export interface AgentResponse {
  ok: boolean;
  intent: ParsedIntent;
  mode: 'query' | 'action';
  portfolio?: PortfolioQueryResult;
  rates?: RatesComparison;
  plan?: HarborActionPlan;
  rationale?: RoutingRationale;
  venueHealth: VenueHealthEntry[];
  degradedMode: boolean;
  banner?: string;
  error?: string;
  parsedAt: number;
}

export const DEFAULT_HORIZON_DAYS = 30;
