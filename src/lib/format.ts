/* ========================================================================== */
/* Formatting helpers. Underlying asset uses 6 decimals (USDC-style).          */
/* Pure functions - shared by server, client and tests.                        */
/* ========================================================================== */

const UNIT = 1_000_000n; // 6 decimals

export function toUnits6(amount: number): bigint {
  // Two decimal places are preserved; further precision is truncated.
  const scaled = Math.round(amount * 100);
  return (BigInt(scaled) * UNIT) / 100n;
}

export function fromUnits6(value: bigint, decimals = 2): number {
  const denom = Number(UNIT);
  return Number(value) / denom;
}

export function formatUsdc(value: bigint, decimals = 2): string {
  const n = Number(value) / Number(UNIT);
  return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function formatUsd(amount: number, decimals = 2): string {
  return amount.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function formatBps(bps: number, decimals = 2): string {
  return `${(bps / 100).toFixed(decimals)}%`;
}

export function formatWad(wad: bigint, decimals = 2): string {
  const pct = (Number(wad) / 1e18) * 100;
  return `${pct.toFixed(decimals)}%`;
}

export function shortAddress(addr: string): string {
  if (addr.length <= 10) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export function formatDays(days: number): string {
  if (days === 365) return '1 year';
  if (days === 30) return '30 days';
  if (days === 1) return '1 day';
  return `${days} days`;
}
