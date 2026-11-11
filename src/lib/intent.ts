import type { ParsedIntent, StructuredIntent, VaultRef } from './types';
import { DEFAULT_HORIZON_DAYS } from './types';

/* ========================================================================== */
/* Harbor NL + Structured Intent Engine (Requirement 02).                      */
/*                                                                            */
/* Deterministic, dependency-free parsing of commands like:                    */
/*   "Show my positions and current APY across all vaults"                     */
/*   "Compare yield rates and available liquidity"                             */
/*   "Deposit 500 USDC into the best yield vault"                              */
/*   "Deposit 25,000 USDC for 14 days"                                         */
/*   "Withdraw 200 USDC from my lowest-yielding position"                      */
/*                                                                            */
/* The parser never guesses amounts: ambiguous or missing amounts produce a    */
/* `unknown` intent with a hint instead of a fabricated action.                */
/* ========================================================================== */

const DEPOSIT_RE = /\b(deposit|supply|put in|add to|invest|allocate|stake)\b/i;
const WITHDRAW_RE = /\b(withdraw|redeem|take out|pull out|cash out|unstake|exit from|remove from|pull)\b/i;
const QUERY_POSITIONS_RE = /\b(show|list|portfolio|position|positions|balance|balances|overview|holdings|how much)\b/i;
const QUERY_RATES_RE = /\b(compare|comparison|rate|rates|apy|apys|yield|yields|interest|tvl|liquidity)\b/i;

const HARBOR_RE = /\b(harbor|harborlend|harbor lend|lending vault|kinked)\b/i;
const PRIME_RE = /\b(prime|staking vault|atlantic prime)\b/i;
const RWA_RE = /\b(rwa|treasury|t-?bill|institutional)\b/i;
const BEST_RE = /\b(best|highest|top|optimal|max(?:imum)?(?: yield| apy)?|greatest|most yield)\b/i;
const LOWEST_RE = /\b(lowest|worst|weakest|cheapest|smallest|minimum yield)\b/i;

const MONEY_RE = /(\$?\s?\d[\d,]*(?:\.\d+)?)\s*(k|m|usdc|dollars|usd)?\b/gi;
const HORIZON_RE =
  /(?:for|over|during|within|horizon\s+of|horizon|next)\s+(\d+(?:\.\d+)?)\s*[-\s]?\s*(days?|d|weeks?|w|months?|mo|years?|y)\b/i;

const UNIT_DAYS: Record<string, number> = {
  d: 1,
  day: 1,
  days: 1,
  w: 7,
  week: 7,
  weeks: 7,
  mo: 30,
  month: 30,
  months: 30,
  y: 365,
  year: 365,
  years: 365,
};

export function daysFromUnit(value: number, unit: string): number {
  const norm = unit.toLowerCase().replace(/\.$/, '');
  const days = UNIT_DAYS[norm] ?? UNIT_DAYS[norm.replace(/s$/, '')] ?? 1;
  return Math.max(1, Math.round(value * days));
}

/** Normalize money strings: "$1,200.50" -> 1200.5, "0.5k" -> 500, "2m" -> 2e6. */
export function normalizeAmount(raw: string, suffix?: string): number | null {
  let text = raw.replace(/\$/g, '').replace(/[\s,]/g, '');
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0) return null;
  let amount = n;
  const sfx = (suffix ?? '').toLowerCase();
  if (sfx === 'k') amount = n * 1_000;
  else if (sfx === 'm') amount = n * 1_000_000;
  return amount;
}

interface MoneyHit {
  value: number;
  index: number;
  raw: string;
}

function findMoneyHits(text: string): MoneyHit[] {
  const hits: MoneyHit[] = [];
  MONEY_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MONEY_RE.exec(text)) !== null) {
    // Skip horizon numbers ("for 14 days") - they are durations, not amounts.
    const before = text.slice(Math.max(0, m.index - 12), m.index).toLowerCase();
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 6).toLowerCase();
    if (/\b(for|over|during|within|horizon|next)\s*$/i.test(before)) continue;
    if (/^\s*[-\s]?\s*(days?|d|weeks?|w|months?|mo|years?|y)\b/i.test(after) && !/usdc/i.test(m[0])) continue;

    const value = normalizeAmount(m[1], m[2]);
    if (value !== null && value > 0) {
      hits.push({ value, index: m.index, raw: m[0] });
    }
  }
  return hits;
}

export function parseHorizonDays(text: string): { horizonDays: number; matched: string[] } {
  const matched: string[] = [];
  const h = HORIZON_RE.exec(text);
  if (h) {
    matched.push(h[0]);
    return { horizonDays: daysFromUnit(Number(h[1]), h[2]), matched };
  }
  // Compact form "for 14d" only when attached to a horizon-ish context word.
  const compact = /(?:for|over|horizon(?: of)?|next)\s+(\d+(?:\.\d+)?)\s*(d|w|mo|y)\b/i.exec(text);
  if (compact) {
    matched.push(compact[0]);
    return { horizonDays: daysFromUnit(Number(compact[1]), compact[2]), matched };
  }
  return { horizonDays: DEFAULT_HORIZON_DAYS, matched };
}

function detectVaultRef(text: string): { ref: VaultRef | null; matched: string[] } {
  const matched: string[] = [];
  if (HARBOR_RE.test(text)) {
    matched.push('harbor');
    return { ref: 'HARBOR_LEND', matched };
  }
  if (PRIME_RE.test(text)) {
    matched.push('prime');
    return { ref: 'ATLANTIC_PRIME', matched };
  }
  if (RWA_RE.test(text)) {
    matched.push('rwa');
    return { ref: 'PHAROS_RWA', matched };
  }
  if (LOWEST_RE.test(text)) {
    matched.push('lowest');
    return { ref: 'lowest-yield', matched };
  }
  if (BEST_RE.test(text)) {
    matched.push('best');
    return { ref: 'best', matched };
  }
  return { ref: null, matched };
}

function laterIndexOf(text: string, re: RegExp): number {
  const m = re.exec(text);
  return m ? m.index : -1;
}

/**
 * Parse a natural-language command into a ParsedIntent.
 * Never throws; unparseable input yields kind 'unknown' with a hint.
 */
export function parseIntent(text: string): ParsedIntent {
  const raw = text.trim();
  if (raw.length === 0) {
    return { kind: 'unknown', raw, confidence: 0, matched: [], hint: 'Empty command.' };
  }

  const withdrawIdx = laterIndexOf(raw, WITHDRAW_RE);
  const depositIdx = laterIndexOf(raw, DEPOSIT_RE);

  // Action detection: whichever action keyword appears later wins; queries
  // only apply when no action keyword exists.
  if (withdrawIdx >= 0 || depositIdx >= 0) {
    const isWithdraw = withdrawIdx > depositIdx;
    const matched: string[] = [];
    const money = findMoneyHits(raw);
    if (money.length === 0) {
      return {
        kind: 'unknown',
        raw,
        confidence: 0.3,
        matched,
        hint: isWithdraw
          ? 'Specify an amount to withdraw, e.g. "Withdraw 200 USDC from my lowest-yielding position".'
          : 'Specify an amount to deposit, e.g. "Deposit 500 USDC into the best yield vault".',
      };
    }
    // Prefer the money hit nearest to the action verb; else the first hit.
    const actionIdx = isWithdraw ? withdrawIdx : depositIdx;
    const hit = money.reduce((best, h) =>
      Math.abs(h.index - actionIdx) < Math.abs(best.index - actionIdx) ? h : best,
    );
    matched.push(hit.raw.trim());

    const { horizonDays, matched: hMatched } = parseHorizonDays(raw);
    matched.push(...hMatched);

    const { ref, matched: refMatched } = detectVaultRef(raw);
    matched.push(...refMatched);

    return isWithdraw
      ? {
          kind: 'withdraw',
          raw,
          amount: hit.value,
          horizonDays,
          source: ref ?? 'lowest-yield',
          confidence: ref ? 0.95 : 0.85,
          matched,
        }
      : {
          kind: 'deposit',
          raw,
          amount: hit.value,
          horizonDays,
          target: ref ?? 'best',
          confidence: ref ? 0.95 : 0.85,
          matched,
        };
  }

  if (QUERY_POSITIONS_RE.test(raw)) {
    return {
      kind: 'query_portfolio',
      raw,
      confidence: 0.9,
      matched: [],
    };
  }

  if (QUERY_RATES_RE.test(raw)) {
    const { horizonDays, matched } = parseHorizonDays(raw);
    return {
      kind: 'query_rates',
      raw,
      horizonDays,
      confidence: 0.85,
      matched,
    };
  }

  return {
    kind: 'unknown',
    raw,
    confidence: 0,
    matched: [],
    hint: 'Try "Show my positions and current APY across all vaults", "Deposit 500 USDC into the best yield vault" or "Withdraw 200 USDC".',
  };
}

const VALID_REFS: readonly VaultRef[] = ['best', 'lowest-yield', 'HARBOR_LEND', 'ATLANTIC_PRIME', 'PHAROS_RWA'];

function isVaultRef(v: unknown): v is VaultRef {
  return typeof v === 'string' && VALID_REFS.includes(v as VaultRef);
}

/**
 * Parse and validate a structured (machine) intent. Throws nothing; invalid
 * fields are dropped so downstream routing applies deterministic defaults.
 */
export function parseStructuredIntent(input: unknown): ParsedIntent {
  if (typeof input !== 'object' || input === null) {
    return { kind: 'unknown', raw: String(input ?? ''), confidence: 0, matched: [], hint: 'Structured intent must be a JSON object.' };
  }
  const obj = input as Record<string, unknown>;
  const action = obj['action'];

  const amount =
    typeof obj['amount'] === 'number' && Number.isFinite(obj['amount']) && (obj['amount'] as number) > 0
      ? (obj['amount'] as number)
      : undefined;
  const horizonDays =
    typeof obj['horizonDays'] === 'number' && Number.isFinite(obj['horizonDays'])
      ? Math.min(3650, Math.max(1, Math.round(obj['horizonDays'] as number)))
      : DEFAULT_HORIZON_DAYS;
  const target = isVaultRef(obj['target']) ? (obj['target'] as VaultRef) : undefined;
  const source = isVaultRef(obj['source']) ? (obj['source'] as VaultRef) : undefined;

  const partial: StructuredIntent = { action: 'query_portfolio' };

  switch (action) {
    case 'deposit':
    case 'withdraw': {
      if (amount === undefined) {
        return {
          kind: 'unknown',
          raw: JSON.stringify(obj),
          confidence: 0.2,
          matched: [],
          hint: `Structured ${action} requires a positive numeric "amount".`,
        };
      }
      return action === 'deposit'
        ? {
            kind: 'deposit',
            raw: JSON.stringify(obj),
            amount,
            horizonDays,
            target: target ?? 'best',
            confidence: 1,
            matched: ['structured'],
          }
        : {
            kind: 'withdraw',
            raw: JSON.stringify(obj),
            amount,
            horizonDays,
            source: source ?? 'lowest-yield',
            confidence: 1,
            matched: ['structured'],
          };
    }
    case 'query_rates':
      partial.action = 'query_rates';
      return { kind: 'query_rates', raw: JSON.stringify(obj), horizonDays, confidence: 1, matched: ['structured'] };
    case 'query_portfolio':
    default:
      return { kind: 'query_portfolio', raw: JSON.stringify(obj), confidence: 1, matched: ['structured'] };
  }
}

/** Convert any ParsedIntent into the StructuredIntent the engine dispatches. */
export function intentToStructured(intent: ParsedIntent): StructuredIntent {
  switch (intent.kind) {
    case 'deposit':
      return { action: 'deposit', amount: intent.amount, horizonDays: intent.horizonDays, target: intent.target };
    case 'withdraw':
      return { action: 'withdraw', amount: intent.amount, horizonDays: intent.horizonDays, source: intent.source };
    case 'query_rates':
      return { action: 'query_rates', horizonDays: intent.horizonDays };
    case 'query_portfolio':
      return { action: 'query_portfolio' };
    default:
      return { action: 'query_portfolio' };
  }
}
