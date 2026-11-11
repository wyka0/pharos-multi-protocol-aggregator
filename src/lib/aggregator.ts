import type { Address } from 'viem';
import { ResilientAdapterMesh } from './resilience';
import type { MeshAdapter } from './resilience';
import { DEFAULT_GAS_POLICY, type GasPolicy, buildDepositRationale, evaluateDepositCandidates, planOptimalWithdrawal, selectBestCandidate } from './router';
import { buildDepositPlan, buildWithdrawPlan, formatPlanConfirmationCard } from './payload';
import { assertAirgappedPlan } from './airgap';
import { intentToStructured, parseIntent, parseStructuredIntent } from './intent';
import type { AgentResponse, CandidateEvaluation, HarborActionPlan, PortfolioQueryResult, ProtocolId, RatesComparison, RoutingRationale, UserPosition, VenueHealthEntry, VenueSnapshot } from './types';
import { DEFAULT_HORIZON_DAYS } from './types';
import { formatBps, formatUsdc, toUnits6 } from './format';

/* ========================================================================== */
/* HarborAggregator - the agent core orchestrator.                             */
/*                                                                            */
/* Guarantees (Requirement 02 + 04):                                           */
/*   - handle() NEVER throws: every failure mode is a structured response.     */
/*   - Queries aggregate across all healthy protocols via the resilient mesh.  */
/*   - Actions produce NON-CUSTODIAL unsigned payloads (airgap-asserted).      */
/* ========================================================================== */

export interface AggregatorConfig {
  defaultHorizonDays: number;
  gasPolicy: GasPolicy;
  /** Underlying token address (suite tUSDC). */
  underlyingAddress: Address;
}

export const DEFAULT_AGGREGATOR_CONFIG: Omit<AggregatorConfig, 'underlyingAddress'> = {
  defaultHorizonDays: DEFAULT_HORIZON_DAYS,
  gasPolicy: DEFAULT_GAS_POLICY,
};

export class HarborAggregator {
  readonly mesh: ResilientAdapterMesh;
  readonly config: AggregatorConfig;

  constructor(mesh: ResilientAdapterMesh, config: AggregatorConfig) {
    this.mesh = mesh;
    this.config = config;
  }

  get adapters(): readonly MeshAdapter[] {
    return this.mesh.adapterList;
  }

  /* ------------------------------ queries -------------------------------- */

  async queryPortfolio(user: Address | null): Promise<PortfolioQueryResult> {
    const { snapshots, health } = await this.mesh.fetchAllSnapshots();
    const excluded = health.filter((h) => h.excludedFromRouting);

    const positionResults = await Promise.allSettled(
      snapshots.map((s) => this.mesh.fetchPosition(s.protocolId, user ?? '0x0000000000000000000000000000000000000000', !s.paused)),
    );

    const positions: UserPosition[] = [];
    positionResults.forEach((r, i) => {
      // Only healthy venues enter the unified portfolio view; degraded venues
      // stay visible through the excluded health list (Requirement 04).
      if (r.status === 'fulfilled' && r.value.ok && r.value.data && !snapshots[i].paused) {
        positions.push(r.value.data);
      }
    });

    const healthyPositions = positions;
    const underlyingValue = healthyPositions.reduce((acc, p) => acc + p.underlyingValue, 0n);
    const accruedYield = healthyPositions.reduce((acc, p) => acc + p.accruedYield, 0n);
    const weightedNetApyBps =
      underlyingValue === 0n
        ? 0
        : Math.round(
            healthyPositions.reduce((acc, p) => acc + p.netApyBps * Number(p.underlyingValue), 0) / Number(underlyingValue),
          );

    return {
      user,
      positions,
      totals: { underlyingValue, accruedYield, positionsCount: healthyPositions.length },
      perVenue: snapshots.filter((s) => !s.paused && !health.find((h) => h.protocolId === s.protocolId)?.excludedFromRouting),
      weightedNetApyBps,
      excluded,
    };
  }

  async compareRates(horizonDays: number): Promise<RatesComparison> {
    const { snapshots, health } = await this.mesh.fetchAllSnapshots();
    return {
      horizonDays,
      venues: snapshots.map((s) => ({
        protocolId: s.protocolId,
        label: s.label,
        archetype: s.archetype,
        spotApyBps: s.spotApyBps,
        entryFeeBps: s.entryFeeBps,
        exitFeeBps: s.exitFeeBps,
        totalTvl: s.totalTvl,
        availableLiquidity: s.availableLiquidity,
        utilizationWad: s.utilizationWad,
        healthy: !s.paused && !health.find((h) => h.protocolId === s.protocolId)?.excludedFromRouting,
      })),
      excluded: health.filter((h) => h.state !== 'HEALTHY'),
    };
  }

  /* ------------------------------ actions -------------------------------- */

  async planDeposit(args: {
    user: Address;
    amount: number;
    horizonDays: number;
    target: 'best' | ProtocolId;
    parsedFrom: string;
  }): Promise<{ ok: boolean; plan: HarborActionPlan | null; rationale: RoutingRationale; banner?: string; error?: string }> {
    const { user, amount, horizonDays, target, parsedFrom } = args;
    const amountUnits = toUnits6(amount);
    const { snapshots, health } = await this.mesh.fetchAllSnapshots();

    const candidates = evaluateDepositCandidates({
      snapshots,
      health,
      adapters: this.adapters,
      amount: amountUnits,
      horizonDays,
      gasPolicy: this.config.gasPolicy,
    });

    const degradedNotes = health
      .filter((h) => h.excludedFromRouting)
      .map((h) => `${h.label} unavailable (Excluded from routing - reason: ${h.state}${h.reason ? ` - ${h.reason}` : ''})`);

    // Specific-venue routing: honor the user's choice but refuse if unhealthy.
    if (target !== 'best') {
      const targetSnapshot = snapshots.find((s) => s.protocolId === target);
      const targetHealth = health.find((h) => h.protocolId === target);
      const unavailable = !targetSnapshot || targetSnapshot.paused || targetHealth?.excludedFromRouting;
      if (unavailable) {
        const rationale = buildDepositRationale({ candidates, amount: amountUnits, horizonDays, venueHealth: health, degradedNotes });
        rationale.summary =
          `Requested venue ${target} is unavailable (${targetHealth?.reason ?? 'not found'}) - refusing to re-route to a different protocol without explicit consent. ` +
          `Retry with "best" targeting or after the venue recovers.`;
        return { ok: false, plan: null, rationale, banner: degradedBanner(health) };
      }
      const pinned = candidates.find((c) => c.protocolId === target)!;
      pinned.selected = true;
      const rationale = buildDepositRationale({ candidates: [pinned], amount: amountUnits, horizonDays, venueHealth: health, degradedNotes });
      const adapter = this.adapters.find((a) => a.protocolId === target)!;
      const plan = buildDepositPlan({
        user,
        amount: amountUnits,
        horizonDays,
        selected: pinned,
        adapter,
        underlyingAddress: this.config.underlyingAddress,
        gasPolicy: this.config.gasPolicy,
        rationale,
        candidates,
        parsedFrom,
      });
      return { ok: true, plan: assertAirgappedPlan(plan), rationale, banner: degradedBanner(health) };
    }

    const selected = selectBestCandidate(candidates);
    const rationale = buildDepositRationale({ candidates, amount: amountUnits, horizonDays, venueHealth: health, degradedNotes });

    if (!selected) {
      // Graceful degradation: a structured "no venue" result, never a 500.
      return { ok: false, plan: null, rationale, banner: degradedBanner(health) };
    }

    const adapter = this.adapters.find((a) => a.protocolId === selected.protocolId)!;
    const plan = buildDepositPlan({
      user,
      amount: amountUnits,
      horizonDays,
      selected,
      adapter,
      underlyingAddress: this.config.underlyingAddress,
      gasPolicy: this.config.gasPolicy,
      rationale,
      candidates,
      parsedFrom,
    });

    return { ok: true, plan: assertAirgappedPlan(plan), rationale, banner: degradedBanner(health) };
  }

  async planWithdrawal(args: {
    user: Address;
    amount: number;
    horizonDays: number;
    source: 'best' | 'lowest-yield' | ProtocolId;
    parsedFrom: string;
  }): Promise<{ ok: boolean; plan: HarborActionPlan | null; rationale: RoutingRationale; banner?: string; error?: string }> {
    const { user, amount, horizonDays, source, parsedFrom } = args;
    const amountUnits = toUnits6(amount);

    const { snapshots, health } = await this.mesh.fetchAllSnapshots();
    const snapshotByProtocol = new Map(snapshots.map((s) => [s.protocolId, s]));

    const positionResults = await Promise.allSettled(
      snapshots.map((s) => this.mesh.fetchPosition(s.protocolId, user, !s.paused)),
    );
    const positions: UserPosition[] = [];
    positionResults.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value.ok && r.value.data) {
        positions.push(r.value.data);
      }
    });

    const result = planOptimalWithdrawal({
      positions,
      health,
      amount: amountUnits,
      horizonDays,
      gasPolicy: this.config.gasPolicy,
      source,
    });

    let plan: HarborActionPlan | null = null;
    if (result.ok) {
      plan = buildWithdrawPlan({
        user,
        amount: amountUnits,
        horizonDays,
        legs: result.legs,
        adapters: this.adapters,
        gasPolicy: this.config.gasPolicy,
        rationale: result.rationale,
        comparisonTable: result.rationale.comparisonTable,
        parsedFrom,
      });
      if (plan) plan = assertAirgappedPlan(plan);
    }

    return { ok: result.ok, plan, rationale: result.rationale, banner: degradedBanner(health) };
  }

  /* --------------------------- unified entrypoint ------------------------- */

  /** NL or structured input -> query result or non-custodial action plan. */
  async handle(input: {
    text?: string;
    structured?: unknown;
    user?: Address | null;
    horizonDays?: number;
  }): Promise<AgentResponse> {
    try {
      const intent =
        input.structured !== undefined
          ? parseStructuredIntent(input.structured)
          : parseIntent(input.text ?? '');

      if (intent.kind === 'unknown') {
        return {
          ok: false,
          intent,
          mode: 'query',
          venueHealth: this.mesh.healthSnapshot(),
          degradedMode: this.mesh.healthSnapshot().some((h) => h.excludedFromRouting),
          error: intent.hint,
          parsedAt: Date.now(),
        };
      }

      const user = input.user ?? null;
      const horizonDays =
        input.horizonDays ?? (intent.kind === 'deposit' || intent.kind === 'withdraw' || intent.kind === 'query_rates' ? intent.horizonDays : this.config.defaultHorizonDays);

      if (intent.kind === 'query_portfolio') {
        const portfolio = await this.queryPortfolio(user);
        return {
          ok: true,
          intent,
          mode: 'query',
          portfolio,
          venueHealth: this.mesh.healthSnapshot(),
          degradedMode: portfolio.excluded.length > 0,
          banner: degradedBanner(this.mesh.healthSnapshot()),
          parsedAt: Date.now(),
        };
      }

      if (intent.kind === 'query_rates') {
        const rates = await this.compareRates(horizonDays);
        return {
          ok: true,
          intent,
          mode: 'query',
          rates,
          venueHealth: this.mesh.healthSnapshot(),
          degradedMode: rates.excluded.length > 0,
          banner: degradedBanner(this.mesh.healthSnapshot()),
          parsedAt: Date.now(),
        };
      }

      if (!user) {
        return {
          ok: false,
          intent,
          mode: 'action',
          venueHealth: this.mesh.healthSnapshot(),
          degradedMode: false,
          error: 'Connect a wallet address (read-only) before preparing actions - the agent core is non-custodial and never holds keys.',
          parsedAt: Date.now(),
        };
      }

      if (intent.kind === 'deposit') {
        const target = intent.target === 'lowest-yield' ? 'best' : intent.target;
        const res = await this.planDeposit({
          user,
          amount: intent.amount,
          horizonDays: intent.horizonDays,
          target,
          parsedFrom: intent.raw,
        });
        return {
          ok: res.ok,
          intent,
          mode: 'action',
          plan: res.plan ?? undefined,
          rationale: res.rationale,
          venueHealth: this.mesh.healthSnapshot(),
          degradedMode: res.rationale.degradedMode,
          banner: res.banner,
          error: res.ok ? undefined : res.rationale.summary,
          parsedAt: Date.now(),
        };
      }

      // withdraw
      const source = intent.source === 'best' ? 'best' : intent.source;
      const res = await this.planWithdrawal({
        user,
        amount: intent.amount,
        horizonDays: intent.horizonDays,
        source,
        parsedFrom: intent.raw,
      });
      return {
        ok: res.ok,
        intent,
        mode: 'action',
        plan: res.plan ?? undefined,
        rationale: res.rationale,
        venueHealth: this.mesh.healthSnapshot(),
        degradedMode: res.rationale.degradedMode,
        banner: res.banner,
        error: res.ok ? undefined : res.rationale.summary,
        parsedAt: Date.now(),
      };
    } catch (e) {
      // Absolute last-resort guard: the agent core never 500s.
      let venueHealth: VenueHealthEntry[] = [];
      try {
        venueHealth = this.mesh.healthSnapshot();
      } catch {
        venueHealth = [];
      }
      return {
        ok: false,
        intent: { kind: 'unknown', raw: input.text ?? JSON.stringify(input.structured ?? ''), confidence: 0, matched: [], hint: 'internal error' },
        mode: 'query',
        venueHealth,
        degradedMode: true,
        error: `Agent core degraded gracefully: ${e instanceof Error ? e.message : String(e)}`,
        parsedAt: Date.now(),
      };
    }
  }

  /** Verbatim comparison-table renderer for evidence transcripts. */
  renderComparisonTable(candidates: CandidateEvaluation[], horizonDays: number): string {
    const rows = candidates.map((c) => {
      return [
        c.selected ? '*' : ' ',
        c.label.padEnd(20),
        `headline ${formatBps(c.headlineApyBps)}`.padEnd(18),
        `post-dx ${formatBps(c.postDepositApyBps)}`.padEnd(16),
        `entryFee ${c.entryFeeBps}bps (${formatUsdc(c.entryFeeCost)})`.padEnd(24),
        `gross ${formatUsdc(c.grossYield)}`.padEnd(14),
        `net ${horizonDays}d ${formatUsdc(c.netExpectedYield)}`.padEnd(20),
        `eff ${formatBps(c.effectiveNetApyBps)}`,
        c.healthy ? '' : `[EXCLUDED: ${c.rejectionReasons.join('; ')}]`,
      ].join(' | ');
    });
    return ['venue                  | gross APY        | post-dx APY     | entry fee                  | gross yield  | net return        | eff net APY', ...rows].join('\n');
  }

  confirmationCard(plan: HarborActionPlan): string {
    return formatPlanConfirmationCard(plan);
  }
}

function degradedBanner(health: VenueHealthEntry[]): string | undefined {
  const excluded = health.filter((h) => h.excludedFromRouting);
  if (excluded.length === 0) return undefined;
  return (
    `DEGRADED MODE: ${excluded.map((h) => `${h.label} unavailable (Excluded from routing - reason: ${h.state}${h.reason ? ` - ${h.reason}` : ''})`).join('; ')}. ` +
    `Serving queries and routing across the remaining ${health.length - excluded.length} healthy protocol(s).`
  );
}
