import { AdapterTimeoutError, classifyThrown, messageOf } from './errors';
import type { AdapterFailureKind, AdapterResult, ProtocolId, UserPosition, VenueHealthEntry, VenueSnapshot, VaultHealthState } from './types';
import { getChaosRegistry, type ChaosRegistry } from './chaos';
import type { Address } from 'viem';

/* ========================================================================== */
/* ResilientAdapterMesh (Requirement 04 + Innovation #4).                      */
/*                                                                            */
/*  - Queries all protocol adapters CONCURRENTLY via Promise.allSettled with   */
/*    a per-adapter timeout, so one hanging venue can never stall the others.  */
/*  - Per-protocol CircuitBreaker tracks consecutive failures; >= threshold    */
/*    opens the circuit (calls short-circuit without hitting the RPC) until a  */
/*    half-open probe after the cooldown succeeds and re-closes it.            */
/*  - On-chain `paused` flags map to CIRCUIT_OPEN_PAUSED without counting as   */
/*    adapter failures.                                                        */
/*  - Every query and routing receipt carries a venueHealthSnapshot.           */
/* ========================================================================== */

/** Structural adapter surface the mesh depends on (real adapters satisfy it). */
export interface MeshAdapter {
  readonly protocolId: ProtocolId;
  readonly label: string;
  readonly archetype: string;
  readonly vaultAddress: Address;
  getSnapshot(): Promise<AdapterResult<VenueSnapshot>>;
  getPosition(user: Address, healthy: boolean): Promise<AdapterResult<UserPosition | null>>;
  buildDepositCalldata(amount: bigint, user: Address): { to: Address; data: `0x${string}` };
  buildWithdrawCalldata(netAmount: bigint, user: Address): { to: Address; data: `0x${string}` };
  simulatePostDepositApy(snapshot: VenueSnapshot, dx: bigint): number;
}

export interface MeshConfig {
  /** Per-adapter call timeout in ms. */
  timeoutMs: number;
  /** Consecutive failures before the circuit opens. */
  failureThreshold: number;
  /** How long an open circuit waits before allowing a half-open probe. */
  cooldownMs: number;
}

export const DEFAULT_MESH_CONFIG: MeshConfig = {
  // Must exceed worst-case throttle-queue latency: 3 vaults x ~12 reads at a
  // 6 req/s global RPC budget puts the last venue ~7s deep in the queue.
  timeoutMs: 30_000,
  failureThreshold: 3,
  cooldownMs: 30_000,
};

/* --------------------------- circuit breaker ------------------------------ */

export class CircuitBreaker {
  readonly protocolId: ProtocolId;
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private failures = 0;
  private openedAt: number | null = null;
  private lastError: string | null = null;
  private lastKind: AdapterFailureKind | null = null;

  constructor(protocolId: ProtocolId, config: MeshConfig) {
    this.protocolId = protocolId;
    this.threshold = config.failureThreshold;
    this.cooldownMs = config.cooldownMs;
  }

  get consecutiveFailures(): number {
    return this.failures;
  }

  /** True when an RPC attempt is allowed right now (closed or half-open). */
  canAttempt(now: number = Date.now()): boolean {
    if (this.openedAt === null) return true; // closed
    return now - this.openedAt >= this.cooldownMs; // half-open probe window
  }

  isHalfOpen(now: number = Date.now()): boolean {
    return this.openedAt !== null && now - this.openedAt >= this.cooldownMs;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openedAt = null;
    this.lastError = null;
    this.lastKind = null;
  }

  recordFailure(kind: AdapterFailureKind, message: string, now: number = Date.now()): void {
    this.failures += 1;
    this.lastError = message;
    this.lastKind = kind;
    if (this.failures >= this.threshold) {
      // First crossing opens the circuit; a failed half-open probe re-opens it.
      this.openedAt = now;
    }
  }

  /**
   * If open and past the cooldown, arm a half-open probe: the next attempt is
   * allowed and a success re-closes the circuit, a failure re-opens it.
   */
  beginHalfOpenProbe(now: number = Date.now()): boolean {
    if (this.openedAt !== null && now - this.openedAt >= this.cooldownMs) {
      this.openedAt = now;
      return true;
    }
    return false;
  }

  snapshotState(): { state: VaultHealthState; consecutiveFailures: number; lastError: string | null } {
    if (this.openedAt !== null) {
      return {
        state: this.lastKind === 'PAUSED' ? 'CIRCUIT_OPEN_PAUSED' : 'CIRCUIT_OPEN',
        consecutiveFailures: this.failures,
        lastError: this.lastError,
      };
    }
    if (this.failures === 0) {
      return { state: 'HEALTHY', consecutiveFailures: 0, lastError: null };
    }
    return {
      state:
        this.lastKind === 'TIMEOUT'
          ? 'DEGRADED_TIMEOUT'
          : this.lastKind === 'RPC_REVERT'
            ? 'RPC_REVERT'
            : 'RPC_ERROR',
      consecutiveFailures: this.failures,
      lastError: this.lastError,
    };
  }
}

/* --------------------------------- mesh ----------------------------------- */

export class ResilientAdapterMesh {
  private readonly adapters: MeshAdapter[];
  private readonly config: MeshConfig;
  private readonly breakers = new Map<ProtocolId, CircuitBreaker>();
  private readonly lastHealth = new Map<ProtocolId, VenueHealthEntry>();
  private readonly chaos: ChaosRegistry;

  constructor(adapters: MeshAdapter[], config: Partial<MeshConfig> = {}, chaos: ChaosRegistry = getChaosRegistry()) {
    this.adapters = adapters;
    this.config = { ...DEFAULT_MESH_CONFIG, ...config };
    this.chaos = chaos;
    for (const a of adapters) {
      this.breakers.set(a.protocolId, new CircuitBreaker(a.protocolId, this.config));
      this.lastHealth.set(a.protocolId, {
        protocolId: a.protocolId,
        label: a.label,
        state: 'HEALTHY',
        consecutiveFailures: 0,
        excludedFromRouting: false,
        reason: '',
        latencyMs: null,
      });
    }
  }

  get adapterList(): readonly MeshAdapter[] {
    return this.adapters;
  }

  getAdapter(protocolId: ProtocolId): MeshAdapter | undefined {
    return this.adapters.find((a) => a.protocolId === protocolId);
  }

  /** One adapter call with chaos injection + timeout + breaker bookkeeping.
   *  Only snapshot operations drive the health snapshot (positions must not
   *  downgrade a paused venue back to HEALTHY). */
  private async runGuarded<T>(
    adapter: MeshAdapter,
    op: (a: MeshAdapter) => Promise<AdapterResult<T>>,
    opts: { trackHealth?: boolean } = {},
  ): Promise<AdapterResult<T>> {
    const trackHealth = opts.trackHealth ?? true;
    const breaker = this.breakers.get(adapter.protocolId)!;
    const now = Date.now();

    if (!breaker.canAttempt(now)) {
      // Open circuit: short-circuit WITHOUT touching the RPC. A half-open
      // probe is armed implicitly because canAttempt() flips true after the
      // cooldown; failure then re-opens, success re-closes.
      return {
        ok: false,
        kind: breaker.snapshotState().state === 'CIRCUIT_OPEN_PAUSED' ? 'PAUSED' : 'TIMEOUT',
        message: `${adapter.label}: circuit open (last error: ${breaker.snapshotState().lastError ?? 'unknown'})`,
        latencyMs: 0,
      };
    }

    const startedAt = Date.now();
    try {
      const result = await this.withTimeout(
        this.chaos.wrap(adapter.protocolId, adapter.label, () => op(adapter)),
        this.config.timeoutMs,
        adapter.label,
      );

      if (result.ok) {
        breaker.recordSuccess();
        if (!trackHealth) return result;
        // VenueSnapshot-shaped results carry the on-chain paused flag; other
        // result shapes (positions) are treated as unpaused by default.
        const data: unknown = result.data;
        const paused =
          typeof data === 'object' && data !== null && 'paused' in data ? Boolean((data as { paused: unknown }).paused) : false;
        const pauseReason =
          typeof data === 'object' && data !== null && 'pauseReason' in data
            ? String((data as { pauseReason: unknown }).pauseReason ?? '')
            : '';
        this.lastHealth.set(adapter.protocolId, {
          protocolId: adapter.protocolId,
          label: adapter.label,
          state: paused ? 'CIRCUIT_OPEN_PAUSED' : 'HEALTHY',
          consecutiveFailures: 0,
          excludedFromRouting: paused,
          reason: paused ? `Vault paused on-chain${pauseReason ? ` - ${pauseReason}` : ''}` : '',
          latencyMs: result.latencyMs,
        });
      } else {
        breaker.recordFailure(result.kind, result.message, now);
        if (trackHealth) {
          const state = breaker.snapshotState();
          this.lastHealth.set(adapter.protocolId, {
            protocolId: adapter.protocolId,
            label: adapter.label,
            state: state.state,
            consecutiveFailures: state.consecutiveFailures,
            excludedFromRouting: state.state === 'CIRCUIT_OPEN' || state.state === 'CIRCUIT_OPEN_PAUSED',
            reason: result.message,
            latencyMs: result.latencyMs,
          });
        }
      }
      return result;
    } catch (e) {
      const kind = classifyThrown(e);
      const message = messageOf(e);
      breaker.recordFailure(kind, message, now);
      if (trackHealth) {
        const state = breaker.snapshotState();
        this.lastHealth.set(adapter.protocolId, {
          protocolId: adapter.protocolId,
          label: adapter.label,
          state: state.state,
          consecutiveFailures: state.consecutiveFailures,
          excludedFromRouting: state.state === 'CIRCUIT_OPEN' || state.state === 'CIRCUIT_OPEN_PAUSED',
          reason: message,
          latencyMs: Date.now() - startedAt,
        });
      }
      return { ok: false, kind, message, latencyMs: Date.now() - startedAt };
    }
  }

  private async withTimeout<T>(p: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new AdapterTimeoutError(label, timeoutMs)), timeoutMs);
    });
    try {
      return await Promise.race([p, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Concurrent allSettled snapshot fetch across every venue. */
  async fetchAllSnapshots(): Promise<{
    snapshots: VenueSnapshot[];
    health: VenueHealthEntry[];
    failures: AdapterResult<never>[];
  }> {
    const settled = await Promise.allSettled(this.adapters.map((a) => this.runGuarded(a, (ad) => ad.getSnapshot())));

    const snapshots: VenueSnapshot[] = [];
    const failures: AdapterResult<never>[] = [];

    settled.forEach((s, i) => {
      const adapter = this.adapters[i];
      if (s.status === 'fulfilled') {
        if (s.value.ok) snapshots.push(s.value.data);
        else failures.push(s.value as AdapterResult<never>);
      } else {
        // runGuarded never rejects, but keep the allSettled contract airtight.
        const message = messageOf(s.reason);
        failures.push({ ok: false, kind: classifyThrown(s.reason), message, latencyMs: 0 });
        this.lastHealth.set(adapter.protocolId, {
          protocolId: adapter.protocolId,
          label: adapter.label,
          state: 'RPC_ERROR',
          consecutiveFailures: this.breakers.get(adapter.protocolId)!.consecutiveFailures,
          excludedFromRouting: true,
          reason: message,
          latencyMs: null,
        });
      }
    });

    return { snapshots, health: this.healthSnapshot(), failures };
  }

  async fetchPosition(
    protocolId: ProtocolId,
    user: Address,
    healthy: boolean,
  ): Promise<AdapterResult<UserPosition | null>> {
    const adapter = this.getAdapter(protocolId);
    if (!adapter) {
      return { ok: false, kind: 'RPC_ERROR', message: `no adapter for ${protocolId}`, latencyMs: 0 };
    }
    // Position reads share the breaker but never rewrite the venue health map.
    return this.runGuarded(adapter, (ad) => ad.getPosition(user, healthy), { trackHealth: false });
  }

  healthSnapshot(): VenueHealthEntry[] {
    return this.adapters.map((a) => {
      const cached = this.lastHealth.get(a.protocolId);
      if (cached) return cached;
      const state = this.breakers.get(a.protocolId)!.snapshotState();
      return {
        protocolId: a.protocolId,
        label: a.label,
        state: state.state,
        consecutiveFailures: state.consecutiveFailures,
        excludedFromRouting: false,
        reason: state.lastError ?? '',
        latencyMs: null,
      };
    });
  }

  /** State introspection for tests / UI diagnostics. */
  breakerState(protocolId: ProtocolId): { state: VaultHealthState; consecutiveFailures: number; lastError: string | null } {
    return this.breakers.get(protocolId)!.snapshotState();
  }
}
