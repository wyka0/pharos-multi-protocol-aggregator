import { describe, expect, it } from 'vitest';
import { bigintReplacer, jsonSafe } from '@/lib/json';
import { harborSnapshot } from './helpers';

/* ========================================================================== */
/* jsonSafe: the API-boundary serializer (BigInt -> decimal string).           */
/* Regression guard for the live /api/* routes: without it NextResponse.json  */
/* throws "Do not know how to serialize a BigInt" and the payload is lost.    */
/* ========================================================================== */

describe('jsonSafe: BigInt-safe API serialization', () => {
  it('converts BigInt to decimal string at any depth', () => {
    const out = jsonSafe({
      totalTvl: 82_000_000_000n,
      nested: { wad: 451219512195121951n },
      list: [7n, 'x', 1],
    });
    expect(out).toEqual({
      totalTvl: '82000000000',
      nested: { wad: '451219512195121951' },
      list: ['7', 'x', 1],
    });
  });

  it('preserves precision beyond Number.MAX_SAFE_INTEGER', () => {
    const out = jsonSafe({ wad: 1234567890123456789n }) as { wad: string };
    expect(out.wad).toBe('1234567890123456789');
  });

  it('raw BigInt payloads throw in JSON.stringify; converted ones do not', () => {
    expect(() => JSON.stringify({ x: 1n })).toThrow(/BigInt/);
    expect(() => JSON.stringify(jsonSafe({ x: 1n }))).not.toThrow();
  });

  it('survives a full venue snapshot round-trip', () => {
    const out = jsonSafe(harborSnapshot()) as Record<string, unknown>;
    expect(typeof out.totalTvl).toBe('string');
    expect(typeof out.utilizationWad).toBe('string');
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it('handles undefined and null gracefully', () => {
    expect(jsonSafe(undefined)).toBeNull();
    expect(jsonSafe(null)).toBeNull();
  });

  it('bigintReplacer leaves non-BigInt values untouched', () => {
    const obj = { a: 's', b: 3, c: null, d: true };
    expect(JSON.parse(JSON.stringify(obj, bigintReplacer))).toEqual(obj);
  });
});
