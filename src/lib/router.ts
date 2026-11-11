import type { CandidateEvaluation, ProtocolId, RoutingRationale, UserPosition, VenueHealthEntry, VenueSnapshot, WithdrawLegPlan } from './types';
import { PROTOCOL_LABELS } from './types';
import { formatBps, formatUsdc } from './format';
import { candidateDescriptor, evaluateCandidate, yieldOverHorizon } from './adapters/projection';
import type { MeshAdapter } from './resilience';

/* ========================================================================== */
/* VenueScoringEngine (Requirement 03).                                        */
/*                                                                            */
/* DEPOSITS - horizon-aware net-yield objective:                               */
/*                                                                             */
/*   NetExpectedYield(dx, T) =                                                 */
/*     dx * (1 - entryFee) * PostDepositAPY(dx) * T/365                        */
/*     - EntryFeeCost(dx) - EstimatedGasUSDC                                   */
/*                                                                             */
/*   PostDepositAPY models each vault's utilization response to the deposit:   */
/*     - HarborLend:      U' = borrowed / (cash + dx)      (kinked curve)      */
/*     - AtlanticPrime:   U' = (deposits + dx) / capacity  (dilution curve)    */
/*     - PharosRwa:       flat floor - zero slippage on any size               */
/*                                                                             */
/*   A 500 USDC / 30d deposit routes to the high-headline staking vault; a     */
/*   50k USDC whale deposit dilutes that pool and flips the winner to the      */
/*   lending or RWA venue. A 7-day horizon flips the winner again because the  */
/*   10 bps entry fee cannot amortize over a short horizon.                    */
/*                                                                             */
/* WITHDRAWALS - opportunity-cost minimization with liquidity constraints:     */
/*   Drain the LOWEST net-APY position first; split across venues when a       */
/*   single vault lacks sufficient user balance or vault liquidity.            */
/* ========================================================================== */

export interface GasPolicy {
  /** Modeled per-action gas cost in USDC (same for every venue, so it never   *  distorts the ranking - it is reported in the comparison table). */
  gasCostUsdcPerAction: number;
  /** Static gas-unit estimates attached to unsigned payloads. */
  approveGasUnits: bigint;
  depositGasUnits: bigint;
  withdrawGasUnits: bigint;
}

export const DEFAULT_GAS_POLICY: GasPolicy = {
  gasCostUsdcPerAction: 0.02,
  approveGasUnits: 60_000n,
  depositGasUnits: 185_000n,
  withdrawGasUnits: 165_000n,
};

/* --------------------------- deposit scoring ------------------------------ */

/** The narrow adapter surface the scoring engine needs (client-safe). */
export interface ScoringAdapter {
  readonly protocolId: ProtocolId;
  simulatePostDepositApy(snapshot: VenueSnapshot, dx: bigint): number;
}

export function evaluateDepositCandidates(args: {
  snapshots: VenueSnapshot[];
  health: VenueHealthEntry[];
  adapters: readonly ScoringAdapter[];
  amount: bigint;
  horizonDays: number;
  gasPolicy: GasPolicy;
}): CandidateEvaluation[] {
  const { snapshots, health, adapters, amount, horizonDays, gasPolicy } = args;

  return snapshots
    .slice()
    .sort((a, b) => a.protocolId.localeCompare(b.protocolId))
    .map((snapshot) => {
      const healthEntry = health.find((h) => h.protocolId === snapshot.protocolId);
      const healthy = Boolean(healthEntry && !healthEntry.excludedFromRouting && !snapshot.paused);
      const healthReason = healthEntry?.excludedFromRouting
        ? `venue unavailable - ${healthEntry.state}${healthEntry.reason ? ` (${healthEntry.reason})` : ''}`
        : snapshot.paused
          ? 'vault paused on-chain (circuit breaker engaged)'
          : '';

      const adapter = adapters.find((a) => a.protocolId === snapshot.protocolId);
      const postDepositApyBps = adapter ? adapter.simulatePostDepositApy(snapshot, amount) : snapshot.spotApyBps;

      return evaluateCandidate({
        snapshot,
        amount,
        horizonDays,
        gasCostUsdc: gasPolicy.gasCostUsdcPerAction,
        healthy,
        healthReason,
        postDepositApyBps,
      });
    });
}

/** Deterministic winner: max netExpectedYield, then effective APY, then name. */
export function selectBestCandidate(candidates: CandidateEvaluation[]): CandidateEvaluation | null {
  const healthy = candidates.filter((c) => c.healthy);
  if (healthy.length === 0) return null;
  return healthy.reduce((best, c) => {
    if (c.netExpectedYield > best.netExpectedYield) return c;
    if (c.netExpectedYield < best.netExpectedYield) return best;
    if (c.effectiveNetApyBps > best.effectiveNetApyBps) return c;
    if (c.effectiveNetApyBps < best.effectiveNetApyBps) return best;
    return c.label.localeCompare(best.label) < 0 ? c : best;
  });
}

function humanizeRejection(selected: CandidateEvaluation, rejected: CandidateEvaluation, horizonDays: number): string {
  const delta = selected.netExpectedYield - rejected.netExpectedYield;
  const deltaStr = `${formatUsdc(delta < 0n ? -delta : delta)} USDC ${delta < 0n ? 'better' : 'worse'}`;

  if (!rejected.healthy) {
    return `unavailable - ${rejected.rejectionReasons.join('; ') || 'excluded from routing'}`;
  }

  const causes: string[] = [];
  if (rejected.entryFeeBps > 0) {
    causes.push(
      `${rejected.entryFeeBps} bps entry fee cost ${formatUsdc(rejected.entryFeeCost)} USDC over the ${horizonDays}d horizon`,
    );
  }
  if (rejected.postDepositApyBps < rejected.headlineApyBps - 1) {
    causes.push(
      `post-deposit APY compresses from ${formatBps(rejected.headlineApyBps)} to ${formatBps(rejected.postDepositApyBps)} (utilization/dilution model)`,
    );
  }
  if (causes.length === 0) {
    causes.push(`lower base rate ${formatBps(rejected.headlineApyBps)}`);
  }
  return `+${formatUsdc(rejected.netExpectedYield)} USDC net (${formatBps(rejected.effectiveNetApyBps)} effective) - ${causes.join('; ')}; trails winner by ${deltaStr}`;
}

export function buildDepositRationale(args: {
  candidates: CandidateEvaluation[];
  amount: bigint;
  horizonDays: number;
  venueHealth: VenueHealthEntry[];
  degradedNotes: string[];
}): RoutingRationale {
  const { candidates, amount, horizonDays, venueHealth, degradedNotes } = args;
  const selected = selectBestCandidate(candidates);
  const degradedMode = venueHealth.some((h) => h.excludedFromRouting);

  let summary: string;
  if (!selected) {
    summary =
      'No healthy venue available - every protocol is paused or failing. Query mode remains available; ' +
      'deposit routing will resume automatically once a venue re-opens (circuit breaker half-open probe).';
  } else {
    selected.selected = true;
    const runnerUps = candidates
      .filter((c) => c !== selected)
      .sort((a, b) => (b.netExpectedYield > a.netExpectedYield ? 1 : -1))
      .map((c) => ({
        protocolId: c.protocolId,
        label: c.label,
        netExpectedYield: Number(c.netExpectedYield) / 1e6,
        reason: humanizeRejection(selected, c, horizonDays),
      }));

    const parts = [
      `Selected ${selected.label} (Net ${horizonDays}d return: +${formatUsdc(selected.netExpectedYield)} USDC, ` +
        `${formatBps(selected.effectiveNetApyBps)} effective net APY; post-deposit rate ` +
        `${formatBps(selected.postDepositApyBps)} after utilization modeling)`,
    ];
    for (const r of runnerUps) {
      parts.push(`Rejected ${r.label} (${r.reason})`);
    }
    if (degradedMode) {
      parts.push('DEGRADED MODE: at least one protocol was excluded from routing; the winner was re-evaluated against healthy venues only.');
    }
    summary = parts.join('. ') + '.';
  }

  return {
    action: 'deposit',
    summary,
    selected: selected?.protocolId ?? null,
    comparisonTable: candidates,
    runnerUps: candidates
      .filter((c) => c !== selected)
      .sort((a, b) => (b.netExpectedYield > a.netExpectedYield ? 1 : -1))
      .map((c) => ({
        protocolId: c.protocolId,
        label: c.label,
        netExpectedYield: Number(c.netExpectedYield) / 1e6,
        reason: selected ? humanizeRejection(selected, c, horizonDays) : 'no healthy venue selected',
      })),
    degradedMode,
    degradedNotes,
    horizonDays,
    amountDisplay: `${formatUsdc(amount)} USDC`,
    venueHealth,
  };
}

/* -------------------------- withdrawal planning --------------------------- */

export interface WithdrawalPlanResult {
  ok: boolean;
  legs: WithdrawLegPlan[];
  shortfall: bigint;
  rationale: RoutingRationale;
  selected: ProtocolId | null;
}

export function planOptimalWithdrawal(args: {
  positions: UserPosition[];
  health: VenueHealthEntry[];
  amount: bigint;
  horizonDays: number;
  gasPolicy: GasPolicy;
  source: 'best' | 'lowest-yield' | ProtocolId;
}): WithdrawalPlanResult {
  const { positions, health, amount, horizonDays, gasPolicy, source } = args;
  const degradedNotes: string[] = [];

  const routable = positions.filter((p) => {
    const h = health.find((x) => x.protocolId === p.protocolId);
    if (h?.excludedFromRouting) {
      degradedNotes.push(`${p.label} excluded - ${h.state}${h.reason ? ` (${h.reason})` : ''}`);
      return false;
    }
    return true;
  });

  const eligible = routable
    .filter((p) => p.maxWithdrawable > 0n)
    .sort((a, b) => {
      if (source === 'best') return b.netApyBps - a.netApyBps; // honor explicit "highest" drain order
      return a.netApyBps - b.netApyBps; // default: opportunity-cost minimization
    });

  if (source !== 'best' && source !== 'lowest-yield') {
    const pinned = eligible.filter((p) => p.protocolId === source);
    return assembleWithdrawalPlan({
      ordered: pinned,
      others: eligible.filter((p) => p.protocolId !== source),
      amount,
      horizonDays,
      gasPolicy,
      health,
      degradedNotes,
      source,
    });
  }

  return assembleWithdrawalPlan({
    ordered: eligible,
    others: [],
    amount,
    horizonDays,
    gasPolicy,
    health,
    degradedNotes,
    source,
  });
}

function assembleWithdrawalPlan(args: {
  ordered: UserPosition[];
  others: UserPosition[];
  amount: bigint;
  horizonDays: number;
  gasPolicy: GasPolicy;
  health: VenueHealthEntry[];
  degradedNotes: string[];
  source: 'best' | 'lowest-yield' | ProtocolId;
}): WithdrawalPlanResult {
  const { ordered, others, amount, horizonDays, gasPolicy, health, degradedNotes, source } = args;

  const legs: WithdrawLegPlan[] = [];
  let remaining = amount;

  for (const pos of ordered) {
    if (remaining === 0n) break;
    const take = pos.maxWithdrawable < remaining ? pos.maxWithdrawable : remaining;
    if (take === 0n) continue;

    // Opportunity cost = yield foregone over the horizon by pulling `take`.
    const foregone = yieldOverHorizon(take, pos.netApyBps, horizonDays);
    const capNote = pos.maxWithdrawable < take + remaining ? 'liquidity/balance-capped' : 'full drain of requested amount';

    legs.push({
      protocolId: pos.protocolId,
      label: pos.label,
      vaultAddress: pos.vaultAddress,
      grossAmount: take,
      netAmount: take,
      fromNetApyBps: pos.netApyBps,
      opportunityCostPreserved: `${formatUsdc(foregone)} USDC of ${horizonDays}d yield foregone (${formatBps(pos.netApyBps)} net APY, ${capNote})`,
    });
    remaining -= take;
  }

  const shortfall = remaining;
  const okPlan = shortfall === 0n && legs.length > 0;

  // Comparison table rows (negative yields = opportunity cost of exiting).
  const comparisonTable: CandidateEvaluation[] = [...ordered, ...others].map((p) => {
    const isLeg = legs.some((l) => l.protocolId === p.protocolId);
    const leg = legs.find((l) => l.protocolId === p.protocolId);
    const foregone = yieldOverHorizon(leg?.netAmount ?? (p.maxWithdrawable < amount ? p.maxWithdrawable : amount), p.netApyBps, horizonDays);
    const gasUnits = BigInt(Math.round(gasPolicy.gasCostUsdcPerAction * 1_000_000));
    return {
      protocolId: p.protocolId,
      label: p.label,
      vaultAddress: p.vaultAddress,
      headlineApyBps: p.netApyBps,
      postDepositApyBps: p.netApyBps,
      entryFeeBps: 0,
      exitFeeBps: 0,
      entryFeeCost: 0n,
      grossYield: 0n,
      gasCostUsdc: gasPolicy.gasCostUsdcPerAction,
      netExpectedYield: -(foregone + gasUnits),
      effectiveNetApyBps: p.netApyBps,
      utilizationBeforeWad: 0n,
      utilizationAfterWad: 0n,
      healthy: true,
      selected: isLeg,
      rejectionReasons: isLeg ? [] : [leg === undefined && p.maxWithdrawable === 0n ? 'no withdrawable balance/liquidity' : `not needed - plan fully served by ${legs.map((l) => l.label).join(' + ') || 'higher-priority legs'}`],
    };
  });

  const selected = legs[0]?.protocolId ?? null;
  const degradedMode = degradedNotes.length > 0;

  let summary: string;
  if (legs.length === 0) {
    summary =
      `Cannot withdraw ${formatUsdc(amount)} USDC: no healthy position with available liquidity` +
      (degradedNotes.length > 0 ? ` (${degradedNotes.join('; ')})` : '') + '.';
  } else if (!okPlan) {
    summary =
      `Partial plan: only ${formatUsdc(amount - shortfall)} of ${formatUsdc(amount)} USDC is withdrawable right now ` +
      `(shortfall ${formatUsdc(shortfall)} USDC - position sizes and instant-liquidity caps are exhausted across healthy venues).` +
      (degradedMode ? ` DEGRADED MODE: ${degradedNotes.join('; ')}.` : '');
  } else if (legs.length === 1) {
    const leg = legs[0];
    const alt = ordered.find((p) => p.protocolId !== leg.protocolId && p.maxWithdrawable > 0n);
    const altNote = alt
      ? ` Alternative ${alt.label} at ${formatBps(alt.netApyBps)} net APY would cost ${formatUsdc(yieldOverHorizon(leg.netAmount, alt.netApyBps, horizonDays) - yieldOverHorizon(leg.netAmount, leg.fromNetApyBps, horizonDays))} USDC more in opportunity cost over ${horizonDays}d.`
      : '';
    summary =
      `Selected ${leg.label} for the ${formatUsdc(leg.netAmount)} USDC exit (lowest net APY ${formatBps(leg.fromNetApyBps)} - ` +
      `opportunity cost ${leg.opportunityCostPreserved}).${altNote}`;
  } else {
    const preserved = legs
      .map((l) => `${formatUsdc(l.netAmount)} from ${l.label} (${formatBps(l.fromNetApyBps)} net APY)`)
      .join(' + ');
    summary =
      `Split withdrawal across ${legs.length} venues: ${preserved} - drains the lowest-yielding venue first ` +
      `to preserve maximum remaining portfolio yield over ${horizonDays}d.` + (degradedMode ? ` DEGRADED MODE: ${degradedNotes.join('; ')}.` : '');
  }

  return {
    ok: okPlan,
    legs,
    shortfall,
    selected,
    rationale: {
      action: 'withdraw',
      summary,
      selected,
      comparisonTable,
      runnerUps: comparisonTable
        .filter((c) => !c.selected && c.healthy)
        .map((c) => ({
          protocolId: c.protocolId,
          label: c.label,
          netExpectedYield: Number(c.netExpectedYield) / 1e6,
          reason: c.rejectionReasons.join('; ') || 'not needed',
        })),
      degradedMode,
      degradedNotes,
      horizonDays,
      amountDisplay: `${formatUsdc(amount)} USDC`,
      venueHealth: health,
    },
  };
}

/** Machine-verifiable comparison-table hash input (Innovation #2). */
export function comparisonTableDigest(candidates: CandidateEvaluation[]): string[] {
  return candidates.map((c) => candidateDescriptor(c));
}

export { PROTOCOL_LABELS };
