import type { VaultReadClient } from './adapters/client-types';

/* ========================================================================== */
/* RPC transport hygiene for the Pharos Atlantic endpoint (ZAN-backed).        */
/*                                                                            */
/* The public testnet RPC enforces per-second quotas ("cu limit exceeded;      */
/* Request too fast per second"). Snapshot reads fan out to ~12 calls per      */
/* vault x 3 vaults, so all reads go through a serialized, rate-limited       */
/* queue with exponential-backoff retries on quota errors.                    */
/* ========================================================================== */

export interface ThrottleOptions {
  maxRequestsPerSecond?: number;
  maxRetries?: number;
  baseDelayMs?: number;
}

export function isRateLimitError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /cu limit|too fast|rate limit|too many requests|429/i.test(message);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retry an RPC operation through quota errors with exponential backoff. */
export async function withRpcRetry<T>(fn: () => Promise<T>, label: string, opts: { maxRetries?: number; baseDelayMs?: number } = {}): Promise<T> {
  const maxRetries = opts.maxRetries ?? 5;
  const baseDelayMs = opts.baseDelayMs ?? 900;
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (attempt === maxRetries || !isRateLimitError(e)) throw e;
      const delay = baseDelayMs * 2 ** attempt + Math.random() * 400;
      console.warn(`[rpc-throttle] ${label}: quota hit - retry ${attempt + 1}/${maxRetries} in ${Math.round(delay)}ms`);
      await sleep(delay);
    }
  }
  throw lastError;
}

/**
 * Wrap a viem public client with global serialization + spacing + retries.
 * Under the hood every readContract/getBlockNumber waits for its slot.
 */
export function createThrottledReadClient(inner: VaultReadClient, opts: ThrottleOptions = {}): VaultReadClient {
  const maxPerSecond = opts.maxRequestsPerSecond ?? 6;
  const minGapMs = Math.ceil(1000 / maxPerSecond);
  const maxRetries = opts.maxRetries ?? 5;
  let lastSentAt = 0;
  let chain: Promise<unknown> = Promise.resolve();

  const schedule = <T>(label: string, fn: () => Promise<T>): Promise<T> => {
    const result = chain.then(async () => {
      const now = Date.now();
      const wait = Math.max(0, lastSentAt + minGapMs - now);
      if (wait > 0) await sleep(wait);
      lastSentAt = Date.now();
      return withRpcRetry(fn, label, { maxRetries });
    });
    chain = result.catch(() => undefined);
    return result;
  };

  return {
    async readContract(args) {
      return schedule(`readContract:${String(args.functionName)}`, () => inner.readContract(args));
    },
    async getBlockNumber() {
      return schedule('getBlockNumber', () => inner.getBlockNumber());
    },
  };
}
