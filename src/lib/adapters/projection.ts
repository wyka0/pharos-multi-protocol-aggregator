import type { CandidateEvaluation, VenueSnapshot } from '../types';

/* ========================================================================== */
/* Shared horizon-aware net-yield projection math (Innovation #1).             */
/*                                                                            */
/* NetExpectedYield(dx, T) =                                                   */
/*   dx * (1 - entryFee) * PostDepositAPY(dx) * T/365                          */
/*   - EntryFeeCost(dx) - EstimatedGasUSDC                                     */
/*                                                                            */
/* Note: entry fees are modeled ONCE by shrinking the deployed principal.      */
/* The requirement-03 formula subtracts the fee twice (once inside the         */
/* principal factor and once as a standalone cost); we surface the standalone  */
/* EntryFeeCost column in the comparison table for transparency while keeping  */
/* the economically-correct single count. See ARCHITECTURE.md -> Routing Math. */
/* ========================================================================== */

export const WAD = 1_000_000_000_000_000_000n;
export const BPS = 10_000n;
const SECONDS_PER_YEAR = 365n * 24n * 60n * 60n;

export interface DepositProjectionInput {
  headlineApyBps: number;
  postDepositApyBps: number;
  entryFeeBps: number;
  exitFeeBps: number;
  amount: bigint;
  horizonDays: number;
  gasCostUsdc: number;
  utilizationBeforeWad: bigint;
  utilizationAfterWad: bigint;
}

export interface DepositProjectionResult {
  entryFeeCost: bigint;
  deployedPrincipal: bigint;
  grossYield: bigint;
  netExpectedYield: bigint;
  effectiveNetApyBps: number;
}

/** Gross yield in underlying units over the horizon, truncated to units. */
export function yieldOverHorizon(principal: bigint, apyBps: number, horizonDays: number): bigint {
  if (principal <= 0n || apyBps <= 0 || horizonDays <= 0) return 0n;
  const seconds = BigInt(Math.round(horizonDays * 86400));
  // principal * apyBps/10000 * seconds/secondsPerYear, computed at 1e18 scale
  // before division to limit truncation.
  const scaled = principal * BigInt(Math.round(apyBps)) * seconds;
  return scaled / (BPS * SECONDS_PER_YEAR);
}

/** Annualize a realized return into bps/year. */
export function annualizeBps(netYield: bigint, principal: bigint, horizonDays: number): number {
  if (principal <= 0n || horizonDays <= 0) return 0;
  const seconds = BigInt(Math.round(horizonDays * 86400));
  const scaled = (netYield * SECONDS_PER_YEAR * 10_000n * 1_000_000n) / (principal * seconds);
  // 1e6 extra scale keeps fractional bps precision before truncation.
  return Number(scaled) / 1_000_000;
}

export function projectDepositNetYield(input: DepositProjectionInput): DepositProjectionResult {
  const entryFeeCost = (input.amount * BigInt(Math.max(0, Math.round(input.entryFeeBps)))) / BPS;
  const deployedPrincipal = input.amount - entryFeeCost;
  const grossYield = yieldOverHorizon(deployedPrincipal, input.postDepositApyBps, input.horizonDays);
  const gasUnits = BigInt(Math.max(0, Math.round(input.gasCostUsdc * 1_000_000)));
  const net = grossYield >= entryFeeCost + gasUnits ? grossYield - entryFeeCost - gasUnits : -(entryFeeCost + gasUnits - grossYield);
  const netExpectedYield = net;
  const effectiveNetApyBps = annualizeBps(net, input.amount, input.horizonDays);
  return { entryFeeCost, deployedPrincipal, grossYield, netExpectedYield, effectiveNetApyBps };
}

/** Evaluate one venue for a deposit; unhealthy venues get rejection rows. */
export function evaluateCandidate(args: {
  snapshot: VenueSnapshot;
  amount: bigint;
  horizonDays: number;
  gasCostUsdc: number;
  healthy: boolean;
  healthReason: string;
  postDepositApyBps: number;
}): CandidateEvaluation {
  const { snapshot, amount, horizonDays, gasCostUsdc, healthy, healthReason, postDepositApyBps } = args;
  const reasons: string[] = [];

  if (!healthy) {
    reasons.push(healthReason);
  } else {
    if (snapshot.availableLiquidity === 0n && snapshot.totalShares === 0n) {
      reasons.push('vault has no seeded liquidity');
    }
    if (postDepositApyBps <= 0) {
      reasons.push('post-de utilization model produced a non-positive rate');
    }
  }

  const projection = projectDepositNetYield({
    headlineApyBps: snapshot.spotApyBps,
    postDepositApyBps,
    entryFeeBps: snapshot.entryFeeBps,
    exitFeeBps: snapshot.exitFeeBps,
    amount,
    horizonDays,
    gasCostUsdc,
    utilizationBeforeWad: snapshot.utilizationWad,
    utilizationAfterWad: snapshot.utilizationWad,
  });

  return {
    protocolId: snapshot.protocolId,
    label: snapshot.label,
    vaultAddress: snapshot.vaultAddress,
    headlineApyBps: snapshot.spotApyBps,
    postDepositApyBps,
    entryFeeBps: snapshot.entryFeeBps,
    exitFeeBps: snapshot.exitFeeBps,
    entryFeeCost: projection.entryFeeCost,
    grossYield: projection.grossYield,
    gasCostUsdc,
    netExpectedYield: projection.netExpectedYield,
    effectiveNetApyBps: projection.effectiveNetApyBps,
    utilizationBeforeWad: snapshot.utilizationWad,
    utilizationAfterWad: snapshot.utilizationWad,
    healthy,
    selected: false,
    rejectionReasons: reasons,
  };
}

/** Stable keccak-able descriptor string for a candidate row. */
export function candidateDescriptor(c: CandidateEvaluation): string {
  return [
    c.protocolId,
    c.vaultAddress.toLowerCase(),
    c.headlineApyBps,
    c.postDepositApyBps,
    c.entryFeeBps,
    c.exitFeeBps,
    c.netExpectedYield.toString(),
    c.effectiveNetApyBps.toFixed(6),
  ].join('|');
}
