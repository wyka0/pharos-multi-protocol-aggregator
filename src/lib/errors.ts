import type { AdapterFailureKind } from './types';

/* ========================================================================== */
/* Typed adapter failures. Every failure carries a kind so the resilient mesh  */
/* can classify it deterministically (Requirement 04).                          */
/* ========================================================================== */

export class AdapterError extends Error {
  readonly kind: AdapterFailureKind;

  constructor(kind: AdapterFailureKind, message: string) {
    super(message);
    this.name = 'AdapterError';
    this.kind = kind;
  }
}

export class AdapterTimeoutError extends AdapterError {
  constructor(label: string, timeoutMs: number) {
    super('TIMEOUT', `${label}: no response within ${timeoutMs}ms`);
    this.name = 'AdapterTimeoutError';
  }
}

export class AdapterRevertError extends AdapterError {
  constructor(label: string, message: string) {
    super('RPC_REVERT', `${label}: on-chain call reverted - ${message}`);
    this.name = 'AdapterRevertError';
  }
}

export class AdapterRpcError extends AdapterError {
  constructor(label: string, message: string) {
    super('RPC_ERROR', `${label}: RPC error - ${message}`);
    this.name = 'AdapterRpcError';
  }
}

export class AdapterPausedError extends AdapterError {
  constructor(label: string, reason: string) {
    super('PAUSED', `${label}: vault unavailable (paused) - ${reason}`);
    this.name = 'AdapterPausedError';
  }
}

/** Chaos-drill injection error (simulates one of the real failure kinds). */
export class ChaosError extends AdapterError {
  constructor(kind: AdapterFailureKind, message: string) {
    super(kind, message);
    this.name = 'ChaosError';
  }
}

/** Map an arbitrary thrown value to a deterministic AdapterFailureKind. */
export function classifyThrown(err: unknown): AdapterFailureKind {
  if (err instanceof AdapterError) return err.kind;
  const message = err instanceof Error ? err.message : String(err);
  if (/timeout|abort|ETIMEDOUT|ECONNABORTED/i.test(message)) return 'TIMEOUT';
  if (/revert|require|insufficient|execution reverted|0x[a-f0-9]{8,}/i.test(message)) return 'RPC_REVERT';
  return 'RPC_ERROR';
}

export function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
