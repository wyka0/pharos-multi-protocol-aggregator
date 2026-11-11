import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CircuitBreaker, DEFAULT_MESH_CONFIG, ResilientAdapterMesh } from '@/lib/resilience';
import { ChaosRegistry, getChaosRegistry } from '@/lib/chaos';
import { harborSnapshot, healthyHealth, mockAdapter, primeSnapshot, position, seededSnapshots, slowAdapter, throwingAdapter, USER } from './helpers';

describe('circuit breaker: state machine (Innovation #4)', () => {
  const config = { timeoutMs: 1_000, failureThreshold: 3, cooldownMs: 1_000 };

  it('starts closed/healthy with zero failures', () => {
    const cb = new CircuitBreaker('HARBOR_LEND', config);
    expect(cb.canAttempt()).toBe(true);
    expect(cb.snapshotState()).toMatchObject({ state: 'HEALTHY', consecutiveFailures: 0 });
  });

  it('stays HEALTHY-but-flaky below the threshold', () => {
    const cb = new CircuitBreaker('HARBOR_LEND', config);
    cb.recordFailure('RPC_REVERT', 'boom', 1);
    cb.recordFailure('RPC_REVERT', 'boom', 2);
    expect(cb.canAttempt()).toBe(true);
    expect(cb.snapshotState()).toMatchObject({ state: 'RPC_REVERT', consecutiveFailures: 2 });
  });

  it('opens after the threshold of consecutive failures', () => {
    const cb = new CircuitBreaker('HARBOR_LEND', config);
    for (let i = 0; i < 3; i++) cb.recordFailure('TIMEOUT', 't', i);
    expect(cb.canAttempt(10)).toBe(false);
    expect(cb.snapshotState().state).toBe('CIRCUIT_OPEN');
  });

  it('allows a half-open probe after the cooldown', () => {
    const cb = new CircuitBreaker('HARBOR_LEND', config);
    for (let i = 0; i < 3; i++) cb.recordFailure('TIMEOUT', 't', 0);
    expect(cb.canAttempt(500)).toBe(false);
    expect(cb.canAttempt(1_001)).toBe(true);
    expect(cb.isHalfOpen(1_001)).toBe(true);
    expect(cb.beginHalfOpenProbe(1_001)).toBe(true);
  });

  it('success resets the failure count and re-closes the circuit', () => {
    const cb = new CircuitBreaker('HARBOR_LEND', config);
    cb.recordFailure('TIMEOUT', 't');
    cb.recordFailure('TIMEOUT', 't');
    cb.recordSuccess();
    expect(cb.consecutiveFailures).toBe(0);
    expect(cb.snapshotState().state).toBe('HEALTHY');
  });

  it('maps TIMEOUT failures to DEGRADED_TIMEOUT while closed', () => {
    const cb = new CircuitBreaker('HARBOR_LEND', config);
    cb.recordFailure('TIMEOUT', 't');
    expect(cb.snapshotState().state).toBe('DEGRADED_TIMEOUT');
  });

  it('maps RPC_REVERT failures to RPC_REVERT while closed', () => {
    const cb = new CircuitBreaker('HARBOR_LEND', config);
    cb.recordFailure('RPC_REVERT', 'r');
    expect(cb.snapshotState().state).toBe('RPC_REVERT');
  });

  it('a failed half-open probe re-opens the window', () => {
    const cb = new CircuitBreaker('HARBOR_LEND', config);
    for (let i = 0; i < 3; i++) cb.recordFailure('TIMEOUT', 't', 0);
    // probe at 2000 fails -> window re-arms
    cb.recordFailure('TIMEOUT', 'probe', 2_000);
    expect(cb.canAttempt(2_100)).toBe(false);
    expect(cb.canAttempt(3_000)).toBe(true);
  });
});

describe('resilient mesh: concurrent allSettled queries', () => {
  let chaos: ChaosRegistry;
  beforeEach(() => {
    chaos = new ChaosRegistry();
  });

  it('returns every healthy snapshot with HEALTHY health entries', async () => {
    const [a, b, c] = seededSnapshots().map((s) => mockAdapter({ snapshot: s }));
    const mesh = new ResilientAdapterMesh([a, b, c], { timeoutMs: 500, failureThreshold: 3, cooldownMs: 100 }, chaos);
    const res = await mesh.fetchAllSnapshots();
    expect(res.snapshots).toHaveLength(3);
    expect(res.failures).toHaveLength(0);
    expect(res.health.every((h) => h.state === 'HEALTHY' && !h.excludedFromRouting)).toBe(true);
  });

  it('isolates one failed protocol without throwing (Requirement 04)', async () => {
    const [a, b, c] = seededSnapshots().map((s) => mockAdapter({ snapshot: s }));
    const broken = mockAdapter({ protocolId: 'PHAROS_RWA', failWith: 'RPC_ERROR', failMessage: 'vault paused' });
    const mesh = new ResilientAdapterMesh([a, b, broken], { timeoutMs: 500, failureThreshold: 3, cooldownMs: 100 }, chaos);
    const res = await mesh.fetchAllSnapshots();
    expect(res.snapshots).toHaveLength(2);
    expect(res.snapshots.map((s) => s.protocolId)).toEqual(['HARBOR_LEND', 'ATLANTIC_PRIME']);
    expect(res.failures).toHaveLength(1);
    expect(res.failures[0].kind).toBe('RPC_ERROR');
  });

  it('survives TWO failed protocols and still serves the third', async () => {
    const healthy = mockAdapter({ snapshot: harborSnapshot() });
    const brokenA = mockAdapter({ protocolId: 'ATLANTIC_PRIME', failWith: 'RPC_REVERT', failMessage: 'revert' });
    const brokenB = mockAdapter({ protocolId: 'PHAROS_RWA', failWith: 'RPC_ERROR', failMessage: 'down' });
    const mesh = new ResilientAdapterMesh([healthy, brokenA, brokenB], { timeoutMs: 500, failureThreshold: 10, cooldownMs: 100 }, chaos);
    const res = await mesh.fetchAllSnapshots();
    expect(res.snapshots).toHaveLength(1);
    expect(res.snapshots[0].protocolId).toBe('HARBOR_LEND');
  });

  it('classifies adapter reverts as RPC_REVERT', async () => {
    const broken = throwingAdapter('PHAROS_RWA', new Error('execution reverted: SuiteVault: paused'));
    const mesh = new ResilientAdapterMesh([broken], { timeoutMs: 500, failureThreshold: 10, cooldownMs: 100 }, chaos);
    const res = await mesh.fetchAllSnapshots();
    expect(res.failures[0].kind).toBe('RPC_REVERT');
    expect(res.health[0].state).toBe('RPC_REVERT');
  });

  it('enforces per-adapter timeouts without blocking other venues', async () => {
    const fast = mockAdapter({ snapshot: primeSnapshot() });
    const slow = slowAdapter('PHAROS_RWA', 300);
    const mesh = new ResilientAdapterMesh([fast, slow], { timeoutMs: 50, failureThreshold: 10, cooldownMs: 100 }, chaos);
    const res = await mesh.fetchAllSnapshots();
    expect(res.snapshots).toHaveLength(1);
    expect(res.snapshots[0].protocolId).toBe('ATLANTIC_PRIME');
    expect(res.failures[0].kind).toBe('TIMEOUT');
    expect(res.health.find((h) => h.protocolId === 'PHAROS_RWA')?.state).toBe('DEGRADED_TIMEOUT');
  });

  it('marks on-chain paused venues CIRCUIT_OPEN_PAUSED and excludes them from routing', async () => {
    const paused = rwaPaused();
    const mesh = new ResilientAdapterMesh([paused], { timeoutMs: 500, failureThreshold: 3, cooldownMs: 100 }, chaos);
    const res = await mesh.fetchAllSnapshots();
    expect(res.snapshots).toHaveLength(1); // snapshot still returns (visibility)
    const health = res.health[0];
    expect(health.state).toBe('CIRCUIT_OPEN_PAUSED');
    expect(health.excludedFromRouting).toBe(true);
    expect(health.reason).toContain('paused');
  });

  function rwaPaused() {
    return mockAdapter({ snapshot: harborSnapshot({ protocolId: 'PHAROS_RWA', paused: true, pauseReason: 'chaos-drill: fault isolation demo' }) });
  }

  it('maps chaos TIMEOUT injection to DEGRADED_TIMEOUT', async () => {
    chaos.setForced('ATLANTIC_PRIME', 'TIMEOUT', 'chaos drill');
    const a = mockAdapter({ snapshot: harborSnapshot() });
    const b = mockAdapter({ protocolId: 'ATLANTIC_PRIME', snapshot: primeSnapshot() });
    const mesh = new ResilientAdapterMesh([a, b], { timeoutMs: 500, failureThreshold: 10, cooldownMs: 100 }, chaos);
    const res = await mesh.fetchAllSnapshots();
    expect(res.snapshots.map((s) => s.protocolId)).toEqual(['HARBOR_LEND']);
    expect(res.health.find((h) => h.protocolId === 'ATLANTIC_PRIME')?.state).toBe('DEGRADED_TIMEOUT');
  });

  it('maps chaos RPC_REVERT injection to RPC_REVERT', async () => {
    chaos.setForced('PHAROS_RWA', 'RPC_REVERT', 'chaos revert');
    const mesh = new ResilientAdapterMesh([mockAdapter({ protocolId: 'PHAROS_RWA', snapshot: rwaSnapshotSafe() })], { timeoutMs: 500, failureThreshold: 10, cooldownMs: 100 }, chaos);
    const res = await mesh.fetchAllSnapshots();
    expect(res.failures[0].kind).toBe('RPC_REVERT');
  });

  function rwaSnapshotSafe() {
    return harborSnapshot({ protocolId: 'PHAROS_RWA' });
  }

  it('attaches latency to healthy entries', async () => {
    const mesh = new ResilientAdapterMesh([mockAdapter({ snapshot: harborSnapshot() })], { timeoutMs: 500, failureThreshold: 3, cooldownMs: 100 }, chaos);
    const res = await mesh.fetchAllSnapshots();
    expect(res.health[0].latencyMs).not.toBeNull();
  });
});

describe('resilient mesh: circuit breaker integration', () => {
  let chaos: ChaosRegistry;
  beforeEach(() => {
    chaos = new ChaosRegistry();
  });

  it('opens after repeated failures and short-circuits WITHOUT calling the adapter', async () => {
    let calls = 0;
    const flaky = mockAdapter({ snapshot: harborSnapshot() });
    const counting = {
      ...flaky,
      async getSnapshot() {
        calls += 1;
        return { ok: false as const, kind: 'RPC_ERROR' as const, message: 'down', latencyMs: 1 };
      },
    };
    const mesh = new ResilientAdapterMesh([counting], { timeoutMs: 500, failureThreshold: 2, cooldownMs: 5_000 }, chaos);

    await mesh.fetchAllSnapshots(); // failure 1
    await mesh.fetchAllSnapshots(); // failure 2 -> open
    expect(mesh.breakerState('HARBOR_LEND').state).toBe('CIRCUIT_OPEN');

    await mesh.fetchAllSnapshots(); // short-circuit, no adapter call
    expect(calls).toBe(2);
  });

  it('half-open probe succeeds and closes the circuit after cooldown', async () => {
    let failing = true;
    const flaky = mockAdapter({ snapshot: harborSnapshot() });
    const adapter = {
      ...flaky,
      async getSnapshot() {
        if (failing) return { ok: false as const, kind: 'TIMEOUT' as const, message: 'timeout', latencyMs: 1 };
        return { ok: true as const, data: harborSnapshot(), latencyMs: 1 };
      },
    };
    const mesh = new ResilientAdapterMesh([adapter], { timeoutMs: 500, failureThreshold: 2, cooldownMs: 30 }, chaos);

    await mesh.fetchAllSnapshots();
    await mesh.fetchAllSnapshots();
    expect(mesh.breakerState('HARBOR_LEND').state).toBe('CIRCUIT_OPEN');

    failing = false;
    await new Promise((r) => setTimeout(r, 40)); // cooldown elapses
    const res = await mesh.fetchAllSnapshots();
    expect(res.snapshots).toHaveLength(1);
    expect(mesh.breakerState('HARBOR_LEND').state).toBe('HEALTHY');
  });

  it('fetchPosition routes through the same breaker', async () => {
    const adapter = mockAdapter({ snapshot: harborSnapshot(), position: position('HARBOR_LEND') });
    const mesh = new ResilientAdapterMesh([adapter], { timeoutMs: 500, failureThreshold: 1, cooldownMs: 5_000 }, chaos);
    const okRes = await mesh.fetchPosition('HARBOR_LEND', USER, true);
    expect(okRes.ok).toBe(true);

    // break the adapter -> next call fails -> circuit opens
    (adapter as unknown as { getPosition: () => Promise<{ ok: false; kind: string; message: string; latencyMs: number }> }).getPosition =
      async () => ({ ok: false, kind: 'RPC_ERROR', message: 'dead', latencyMs: 0 });
    await mesh.fetchPosition('HARBOR_LEND', USER, true);
    expect(mesh.breakerState('HARBOR_LEND').state).toBe('CIRCUIT_OPEN');
    const shortCircuit = await mesh.fetchPosition('HARBOR_LEND', USER, true);
    expect(shortCircuit.ok).toBe(false);
  });

  it('unknown protocol ids fail as RPC_ERROR without crashing', async () => {
    const mesh = new ResilientAdapterMesh([mockAdapter({ snapshot: harborSnapshot() })], DEFAULT_MESH_CONFIG, chaos);
    const res = await mesh.fetchPosition('PHAROS_RWA', USER, true);
    expect(res.ok).toBe(false);
  });

  it('healthSnapshot reflects the last observation', async () => {
    const mesh = new ResilientAdapterMesh([mockAdapter({ snapshot: primeSnapshot() })], { timeoutMs: 500, failureThreshold: 3, cooldownMs: 100 }, chaos);
    await mesh.fetchAllSnapshots();
    const health = mesh.healthSnapshot();
    expect(healthyHealth([primeSnapshot()])[0].state).toBe(health[0].state);
  });
});

describe('chaos registry', () => {
  it('records, lists and clears forced outages', () => {
    const chaos = new ChaosRegistry();
    chaos.setForced('HARBOR_LEND', 'TIMEOUT', 'drill');
    chaos.setForced('PHAROS_RWA', 'PAUSED', 'drill2');
    expect(chaos.isForced('HARBOR_LEND')).toBe(true);
    expect(chaos.list()).toHaveLength(2);
    chaos.clear('HARBOR_LEND');
    expect(chaos.isForced('HARBOR_LEND')).toBe(false);
    chaos.clearAll();
    expect(chaos.list()).toHaveLength(0);
  });

  it('global singleton is stable per process', () => {
    expect(getChaosRegistry()).toBe(getChaosRegistry());
  });
});
