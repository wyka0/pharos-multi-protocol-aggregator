import { ChaosError } from './errors';
import type { AdapterFailureKind, ProtocolId } from './types';

/* ========================================================================== */
/* ChaosRegistry - reviewer-facing outage injection (UI "Protocol Chaos"       */
/* toggle). When a protocol is chaos-killed, its adapter transport throws a    */
/* simulated failure so the ResilientAdapterMesh classifies it exactly like a  */
/* real RPC timeout / revert / on-chain pause.                                 */
/* ========================================================================== */

export interface ChaosSpec {
  kind: Extract<AdapterFailureKind, 'TIMEOUT' | 'RPC_REVERT' | 'PAUSED'>;
  message: string;
  setAt: number;
}

export class ChaosRegistry {
  private forced = new Map<ProtocolId, ChaosSpec>();

  setForced(protocolId: ProtocolId, kind: ChaosSpec['kind'], message?: string): void {
    this.forced.set(protocolId, {
      kind,
      message: message ?? `chaos drill: simulated ${kind} on ${protocolId}`,
      setAt: Date.now(),
    });
  }

  clear(protocolId: ProtocolId): void {
    this.forced.delete(protocolId);
  }

  clearAll(): void {
    this.forced.clear();
  }

  isForced(protocolId: ProtocolId): boolean {
    return this.forced.has(protocolId);
  }

  getSpec(protocolId: ProtocolId): ChaosSpec | null {
    return this.forced.get(protocolId) ?? null;
  }

  list(): Array<{ protocolId: ProtocolId } & ChaosSpec> {
    return Array.from(this.forced.entries()).map(([protocolId, spec]) => ({ protocolId, ...spec }));
  }

  /** Wrap an adapter transport call with chaos injection. */
  async wrap<T>(protocolId: ProtocolId, label: string, fn: () => Promise<T>): Promise<T> {
    const spec = this.forced.get(protocolId);
    if (spec) {
      throw new ChaosError(spec.kind, `${label}: ${spec.message}`);
    }
    return fn();
  }
}

const globalForChaos = globalThis as unknown as { __harborChaos?: ChaosRegistry };

/** Server singleton so the UI chaos toggle and the mesh share one registry. */
export function getChaosRegistry(): ChaosRegistry {
  if (!globalForChaos.__harborChaos) {
    globalForChaos.__harborChaos = new ChaosRegistry();
  }
  return globalForChaos.__harborChaos;
}
