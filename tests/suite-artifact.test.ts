import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import artifact from '@/generated/suite.json';
import { VAULT_ABI, ERC20_ABI, ANCHOR_ABI, SUITE_ABI } from '@/lib/abis';

/* ========================================================================== */
/* Build-artifact consistency: the hand-written runtime ABIs (src/lib/abis.ts) */
/* must stay a subset of the solc-compiled ABIs (src/generated/suite.json).    */
/* ========================================================================== */

function functionNames(abi: { type: string; name?: string }[]): Set<string> {
  return new Set(abi.filter((x) => x.type === 'function').map((x) => x.name as string));
}

function abiOf(name: string): { type: string; name?: string }[] {
  const c = (artifact.contracts as Record<string, { abi: unknown }>)[name];
  if (!c) throw new Error(`artifact missing contract ${name}`);
  return c.abi as { type: string; name?: string }[];
}

describe('suite artifact: compilation output sanity', () => {
  it('contains the facade bytecode', () => {
    expect(artifact.bytecode).toMatch(/^0x[0-9a-fA-F]+$/);
    expect((artifact.bytecode as string).length).toBeGreaterThan(1000);
  });

  it('contains all 6 contracts', () => {
    for (const name of ['PharosVaultSuite', 'HarborLendVault', 'AtlanticPrimeStaking', 'PharosRwaTreasury', 'AggregatorRouteAnchor', 'SuiteToken']) {
      expect(artifact.contracts).toHaveProperty(name);
    }
  });

  it('records the compiler version', () => {
    expect(artifact.compiler.solc).toMatch(/^0\.8\.\d+/);
  });
});

describe('suite artifact: runtime ABI subset checks', () => {
  it('VAULT_ABI functions exist on every vault contract', () => {
    // `capacity` is AtlanticPrimeStaking-specific; all other vault functions
    // must exist on all three contracts.
    const required = [...functionNames(VAULT_ABI as unknown as { type: string; name?: string }[])].filter((f) => f !== 'capacity');
    for (const vault of ['HarborLendVault', 'AtlanticPrimeStaking', 'PharosRwaTreasury']) {
      const onChain = functionNames(abiOf(vault));
      for (const fn of required) {
        expect(onChain.has(fn), `${vault} missing ${fn}`).toBe(true);
      }
    }
    expect(functionNames(abiOf('AtlanticPrimeStaking')).has('capacity')).toBe(true);
  });

  it('ERC20_ABI functions exist on SuiteToken', () => {
    const onChain = functionNames(abiOf('SuiteToken'));
    for (const fn of functionNames(ERC20_ABI as unknown as { type: string; name?: string }[])) {
      expect(onChain.has(fn), `SuiteToken missing ${fn}`).toBe(true);
    }
  });

  it('ANCHOR_ABI functions exist on AggregatorRouteAnchor', () => {
    const onChain = functionNames(abiOf('AggregatorRouteAnchor'));
    for (const fn of functionNames(ANCHOR_ABI as unknown as { type: string; name?: string }[])) {
      expect(onChain.has(fn), `Anchor missing ${fn}`).toBe(true);
    }
  });

  it('SUITE_ABI functions exist on PharosVaultSuite', () => {
    const onChain = functionNames(abiOf('PharosVaultSuite'));
    for (const fn of functionNames(SUITE_ABI as unknown as { type: string; name?: string }[])) {
      expect(onChain.has(fn), `Suite missing ${fn}`).toBe(true);
    }
  });
});

describe('suite artifact: parameter invariants (seeded economy)', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'contracts', 'PharosVaultSuite.sol'), 'utf8');

  it('pins the Harbor seed (45k cash + 37k debt -> U ~ 45.1%)', () => {
    expect(source).toContain('HARBOR_SEED_CASH = 45_000e6');
    expect(source).toContain('HARBOR_SEED_BORROWED = 37_000e6');
  });

  it('pins Prime capacity + dilution (60k capacity, 0.35 strength)', () => {
    expect(source).toContain('PRIME_CAPACITY = 60_000e6');
    expect(source).toContain('DILUTION_STRENGTH_WAD = 35e16');
  });

  it('pins the RWA floor rate at 780 bps', () => {
    expect(source).toContain('FLOOR_APY_BPS = 780');
  });

  it('pins fee schedule: Harbor 0/5, Prime 10/0, RWA 0/0', () => {
    expect(source).toMatch(/HarborLendVault[^]*?SuiteVaultBase\("Harbor Lend Vault", "jHLV", asset_, admin_, 0, 5\)/);
    expect(source).toMatch(/SuiteVaultBase\("Atlantic Prime Staking", "jAPS", asset_, admin_, 10, 0\)/);
    expect(source).toMatch(/SuiteVaultBase\("Pharos RWA Treasury", "jRWA", asset_, admin_, 0, 0\)/);
  });

  it('pins the kinked curve constants', () => {
    expect(source).toContain('KINK_UTIL_WAD = 8e17');
    expect(source).toContain('BASE_RATE_BPS = 200');
    expect(source).toContain('SLOPE1_BPS = 1250');
    expect(source).toContain('SLOPE2_BPS = 94_000');
  });

  it('includes the on-chain circuit breaker', () => {
    expect(source).toContain('setPaused');
    expect(source).toContain('pauseReason');
  });
});
