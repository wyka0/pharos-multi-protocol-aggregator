/**
 * Safe JSON serialization for API boundaries.
 *
 * BigInt is not JSON-serializable: JSON.stringify throws
 * "Do not know how to serialize a BigInt" and the payload would be lost
 * (surfaced to callers as a degraded response). Every route payload passes
 * through `jsonSafe()` before `NextResponse.json()`.
 *
 * BigInts become decimal STRINGS (not numbers): utilization wads and share
 * amounts exceed Number.MAX_SAFE_INTEGER, so string form is lossless and
 * matches the evidence/schema convention ("totalTvl": "82000000000").
 */

/** JSON.stringify replacer that renders BigInt as a decimal string. */
export function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

/**
 * Deep-convert a value into JSON-safe form (BigInt -> string, undefined ->
 * null) so it can cross `NextResponse.json()` without throwing.
 */
export function jsonSafe(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value ?? null, bigintReplacer));
}
