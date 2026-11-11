import { describe, expect, it } from 'vitest';
import { daysFromUnit, intentToStructured, normalizeAmount, parseIntent, parseStructuredIntent } from '@/lib/intent';
import { DEFAULT_HORIZON_DAYS } from '@/lib/types';

describe('intent: normalizeAmount', () => {
  it('parses plain integers', () => expect(normalizeAmount('500')).toBe(500));
  it('parses comma-grouped numbers', () => expect(normalizeAmount('25,000')).toBe(25_000));
  it('parses decimals', () => expect(normalizeAmount('0.5')).toBe(0.5));
  it('strips dollar signs', () => expect(normalizeAmount('$1,200.50')).toBe(1200.5));
  it('expands k suffix', () => expect(normalizeAmount('0.5', 'k')).toBe(500));
  it('expands m suffix', () => expect(normalizeAmount('2', 'm')).toBe(2_000_000));
  it('rejects non-numeric', () => expect(normalizeAmount('abc')).toBeNull());
  it('rejects zero and negatives', () => {
    expect(normalizeAmount('0')).toBeNull();
    expect(normalizeAmount('-5')).toBeNull();
  });
});

describe('intent: daysFromUnit', () => {
  it('handles days', () => expect(daysFromUnit(14, 'days')).toBe(14));
  it('handles weeks', () => expect(daysFromUnit(2, 'weeks')).toBe(14));
  it('handles months', () => expect(daysFromUnit(1, 'month')).toBe(30));
  it('handles years', () => expect(daysFromUnit(1, 'year')).toBe(365));
  it('handles single-letter units', () => expect(daysFromUnit(30, 'd')).toBe(30));
  it('floors fractional inputs', () => expect(daysFromUnit(1.5, 'days')).toBe(2));
});

describe('intent: portfolio queries', () => {
  it('parses the canonical portfolio query', () => {
    const intent = parseIntent('Show my positions and current APY across all vaults');
    expect(intent.kind).toBe('query_portfolio');
    expect(intent.confidence).toBeGreaterThan(0.5);
  });
  it('parses balance overview variants', () => {
    expect(parseIntent('what is my portfolio').kind).toBe('query_portfolio');
    expect(parseIntent('list my balances').kind).toBe('query_portfolio');
    expect(parseIntent('how much do I hold').kind).toBe('query_portfolio');
  });
  it('prefers portfolio over rates when both are mentioned', () => {
    expect(parseIntent('show my positions and current APY').kind).toBe('query_portfolio');
  });
  it('parses rate comparison queries', () => {
    const intent = parseIntent('Compare yield rates and available liquidity');
    expect(intent.kind).toBe('query_rates');
  });
  it('parses apy/tvl phrasing', () => {
    expect(parseIntent('what are the current rates').kind).toBe('query_rates');
    expect(parseIntent('compare apys').kind).toBe('query_rates');
  });
});

describe('intent: deposit commands', () => {
  it('parses the canonical best-vault deposit', () => {
    const intent = parseIntent('Deposit 500 USDC into the best yield vault');
    expect(intent).toMatchObject({ kind: 'deposit', amount: 500, horizonDays: DEFAULT_HORIZON_DAYS, target: 'best' });
  });
  it('parses horizon-qualified whale deposits', () => {
    const intent = parseIntent('Deposit 25,000 USDC for 14 days');
    expect(intent).toMatchObject({ kind: 'deposit', amount: 25_000, horizonDays: 14, target: 'best' });
  });
  it('parses dollar-signed amounts', () => {
    const intent = parseIntent('deposit $1,200 into the highest apy vault');
    expect(intent).toMatchObject({ kind: 'deposit', amount: 1200, target: 'best' });
  });
  it('routes protocol-named deposits to that venue', () => {
    expect(parseIntent('Deposit 100 USDC into HarborLend')).toMatchObject({ target: 'HARBOR_LEND' });
    expect(parseIntent('supply 100 usdc to the prime staking vault')).toMatchObject({ target: 'ATLANTIC_PRIME' });
    expect(parseIntent('Deposit 100 USDC into the RWA treasury')).toMatchObject({ target: 'PHAROS_RWA' });
  });
  it('defaults horizon to 30 days', () => {
    const intent = parseIntent('Deposit 750 USDC');
    expect(intent).toMatchObject({ kind: 'deposit', horizonDays: 30 });
  });
  it('supports supply/stake verbs', () => {
    expect(parseIntent('supply 100 USDC to the best vault').kind).toBe('deposit');
    expect(parseIntent('stake 100 USDC into prime').kind).toBe('deposit');
  });
  it('does not mistake horizon numbers for amounts', () => {
    const intent = parseIntent('Deposit 500 USDC for 30 days');
    expect(intent).toMatchObject({ amount: 500, horizonDays: 30 });
  });
  it('rejects deposits without an amount with a helpful hint', () => {
    const intent = parseIntent('deposit into the best vault please');
    expect(intent.kind).toBe('unknown');
    expect(intent.hint).toContain('amount');
  });
  it('parses k-suffix amounts', () => {
    expect(parseIntent('deposit 2k USDC')).toMatchObject({ amount: 2000 });
  });
});

describe('intent: withdraw commands', () => {
  it('parses the canonical lowest-yield withdrawal', () => {
    const intent = parseIntent('Withdraw 200 USDC from my lowest-yielding position');
    expect(intent).toMatchObject({ kind: 'withdraw', amount: 200, source: 'lowest-yield' });
  });
  it('defaults source to lowest-yield (opportunity-cost routing)', () => {
    const intent = parseIntent('Withdraw 800 USDC');
    expect(intent).toMatchObject({ kind: 'withdraw', amount: 800, source: 'lowest-yield' });
  });
  it('honors explicit protocol sources', () => {
    expect(parseIntent('withdraw 50 USDC from prime')).toMatchObject({ source: 'ATLANTIC_PRIME' });
    expect(parseIntent('redeem 50 USDC from the harbor lending vault')).toMatchObject({ source: 'HARBOR_LEND' });
    expect(parseIntent('pull 50 USDC out of the rwa treasury')).toMatchObject({ source: 'PHAROS_RWA' });
  });
  it('supports redeem/unstake/exit verbs', () => {
    expect(parseIntent('redeem 10 USDC').kind).toBe('withdraw');
    expect(parseIntent('unstake 10 USDC').kind).toBe('withdraw');
    expect(parseIntent('exit from my position, 10 USDC').kind).toBe('withdraw');
  });
  it('rejects withdrawals without amounts', () => {
    const intent = parseIntent('withdraw my funds');
    expect(intent.kind).toBe('unknown');
    expect(intent.hint).toContain('amount');
  });
  it('parses horizon-qualified withdrawals', () => {
    expect(parseIntent('withdraw 100 USDC for 7 days of analysis')).toMatchObject({ horizonDays: 7 });
  });
});

describe('intent: unknown / robustness', () => {
  it('returns unknown for gibberish with a hint', () => {
    const intent = parseIntent('hello world this is a test');
    expect(intent.kind).toBe('unknown');
    expect(intent.confidence).toBe(0);
    expect(intent.hint.length).toBeGreaterThan(10);
  });
  it('handles empty input', () => {
    expect(parseIntent('').kind).toBe('unknown');
    expect(parseIntent('   ').kind).toBe('unknown');
  });
  it('prefers the later action when both verbs appear', () => {
    const intent = parseIntent('deposit 100 USDC then withdraw 100 USDC');
    expect(intent.kind).toBe('withdraw');
    expect(intent).toMatchObject({ amount: 100 });
  });
});

describe('intent: structured parsing', () => {
  it('parses a structured deposit', () => {
    const intent = parseStructuredIntent({ action: 'deposit', amount: 500, horizonDays: 14, target: 'best' });
    expect(intent).toMatchObject({ kind: 'deposit', amount: 500, horizonDays: 14, target: 'best', confidence: 1 });
  });
  it('parses a structured withdraw with default source', () => {
    const intent = parseStructuredIntent({ action: 'withdraw', amount: 200 });
    expect(intent).toMatchObject({ kind: 'withdraw', source: 'lowest-yield', horizonDays: 30 });
  });
  it('parses structured rate queries', () => {
    expect(parseStructuredIntent({ action: 'query_rates', horizonDays: 90 })).toMatchObject({ kind: 'query_rates', horizonDays: 90 });
  });
  it('parses structured portfolio queries', () => {
    expect(parseStructuredIntent({ action: 'query_portfolio' }).kind).toBe('query_portfolio');
  });
  it('clamps out-of-range horizons', () => {
    const intent = parseStructuredIntent({ action: 'deposit', amount: 1, horizonDays: 99_999 });
    expect(intent.kind === 'deposit' && intent.horizonDays).toBe(3650);
  });
  it('rejects structured actions without amounts', () => {
    const intent = parseStructuredIntent({ action: 'deposit' });
    expect(intent.kind).toBe('unknown');
  });
  it('rejects non-object structured input', () => {
    expect(parseStructuredIntent('deposit').kind).toBe('unknown');
    expect(parseStructuredIntent(null).kind).toBe('unknown');
    expect(parseStructuredIntent(42).kind).toBe('unknown');
  });
  it('drops invalid vault refs to defaults', () => {
    const intent = parseStructuredIntent({ action: 'deposit', amount: 5, target: 'MOON' });
    expect(intent.kind === 'deposit' && intent.target).toBe('best');
  });
});

describe('intent: intentToStructured roundtrip', () => {
  it('preserves deposit fields', () => {
    const parsed = parseIntent('Deposit 500 USDC for 14 days');
    const structured = intentToStructured(parsed);
    expect(structured).toEqual({ action: 'deposit', amount: 500, horizonDays: 14, target: 'best' });
  });
  it('preserves withdraw fields', () => {
    const parsed = parseIntent('Withdraw 200 USDC from my lowest-yielding position');
    expect(intentToStructured(parsed)).toEqual({ action: 'withdraw', amount: 200, horizonDays: 30, source: 'lowest-yield' });
  });
  it('maps unknown to a safe portfolio query', () => {
    expect(intentToStructured(parseIntent('nonsense'))).toEqual({ action: 'query_portfolio' });
  });
});
