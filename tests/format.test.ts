import { describe, expect, it } from 'vitest';
import { formatBps, formatUsd, formatUsdc, formatWad, fromUnits6, shortAddress, toUnits6 } from '@/lib/format';

describe('format: toUnits6 (number -> 6dp bigint)', () => {
  it('converts whole numbers', () => expect(toUnits6(500)).toBe(500_000_000n));
  it('converts decimals', () => expect(toUnits6(0.5)).toBe(500_000n));
  it('converts thousands separators via number input', () => expect(toUnits6(25000)).toBe(25_000_000_000n));
  it('converts 25000.001 (sub-cent precision is dropped by design)', () => expect(toUnits6(25000.001)).toBe(25_000_000_000n));
  it('rounds to the nearest cent deterministically', () => expect(toUnits6(1.006)).toBe(1_010_000n));
  it('handles zero', () => expect(toUnits6(0)).toBe(0n));
  it('handles large whale deposits', () => expect(toUnits6(50_000)).toBe(50_000_000_000n));
  it('truncates beyond 2dp instead of drifting', () => expect(toUnits6(1.999999)).toBe(2_000_000n));
});

describe('format: fromUnits6', () => {
  it('converts back to number', () => expect(fromUnits6(500_000_000n)).toBe(500));
  it('handles fractional units', () => expect(fromUnits6(1n)).toBeCloseTo(0.000001));
});

describe('format: formatUsdc', () => {
  it('renders with 2dp by default', () => expect(formatUsdc(1_234_500_000n)).toBe('1,234.50'));
  it('renders 0dp on demand', () => expect(formatUsdc(1_234_500_000n, 0)).toBe('1,235'));
  it('renders zero', () => expect(formatUsdc(0n)).toBe('0.00'));
  it('renders sub-cent values', () => expect(formatUsdc(1n)).toBe('0.00'));
  it('renders small amounts with precision', () => expect(formatUsdc(1_000_000n, 4)).toBe('1.0000'));
  it('formats whale values with separators', () => expect(formatUsdc(50_000_000_000n)).toBe('50,000.00'));
});

describe('format: formatUsd', () => {
  it('formats plain numbers', () => expect(formatUsd(3.14159)).toBe('3.14'));
  it('formats with custom decimals', () => expect(formatUsd(1.5, 1)).toBe('1.5'));
  it('formats zero', () => expect(formatUsd(0)).toBe('0.00'));
  it('formats thousands', () => expect(formatUsd(1234.5)).toBe('1,234.50'));
});

describe('format: formatBps', () => {
  it('converts 940 bps to percent', () => expect(formatBps(940)).toBe('9.40%'));
  it('converts 780 bps', () => expect(formatBps(780)).toBe('7.80%'));
  it('handles fractional bps', () => expect(formatBps(930.86, 2)).toBe('9.31%'));
  it('handles zero', () => expect(formatBps(0)).toBe('0.00%'));
  it('handles 4-digit bps (full utilization)', () => expect(formatBps(12000)).toBe('120.00%'));
});

describe('format: formatWad', () => {
  it('renders 0.4512 WAD as percent', () => expect(formatWad(451_219_512_195_121_951n, 1)).toBe('45.1%'));
  it('renders zero utilization', () => expect(formatWad(0n)).toBe('0.00%'));
  it('renders full utilization', () => expect(formatWad(1_000_000_000_000_000_000n, 0)).toBe('100%'));
});

describe('format: shortAddress', () => {
  it('trims long addresses', () => expect(shortAddress('0x1111111111111111111111111111111111111111')).toBe('0x1111...1111'));
  it('passes through short strings', () => expect(shortAddress('0x1234')).toBe('0x1234'));
});

describe('format: roundtrip integrity', () => {
  it('toUnits6 -> formatUsdc stays stable for typical deposits', () => {
    for (const n of [100, 500, 200, 800, 25_000, 50_000]) {
      expect(formatUsdc(toUnits6(n))).toBe(n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
    }
  });
});
