import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FORBIDDEN_SOURCE_PATTERNS, inspectPayloadAirgap, inspectPlanAirgap } from '@/lib/airgap';
import type { HarborActionPlan, HarborUnsignedPayload } from '@/lib/types';
import { computeRouteCommitment } from '@/lib/commitment';
import { u6, USER, VAULTS } from './helpers';

/* ========================================================================== */
/* Non-custodial airgap enforcement (Requirement 02):                          */
/*   1. src/ contains ZERO key material / wallet clients / broadcast APIs.     */
/*   2. scripts/ DOES reference the test key (proves the scanner discriminates)*/
/*   3. Runtime payloads carry no signer-shaped keys and pass value/chainId    */
/*      invariants.                                                            */
/* ========================================================================== */

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

const root = path.resolve(__dirname, '..');
const SRC = path.join(root, 'src');
const SCRIPTS = path.join(root, 'scripts');

/** The enforcer module itself only defines the regexes - never matches. */
const SCAN_EXEMPT = new Set([path.join(SRC, 'lib', 'airgap.ts')]);

describe('airgap: source-level scan of src/', () => {
  const srcFiles = listFiles(SRC).filter((f) => /\.(ts|tsx)$/.test(f) && !SCAN_EXEMPT.has(f));

  it('scans a meaningful number of source files', () => {
    expect(srcFiles.length).toBeGreaterThan(15);
  });

  for (const pattern of FORBIDDEN_SOURCE_PATTERNS) {
    it(`zero hits for /${pattern.source}/ across all of src/`, () => {
      const hits = srcFiles.filter((f) => pattern.test(fs.readFileSync(f, 'utf8')));
      expect(hits).toEqual([]);
    });
  }

  it('contains no 64-hex private key literals anywhere in src/', () => {
    const keyLiteral = /0x[0-9a-fA-F]{64}/;
    for (const f of srcFiles) {
      expect(keyLiteral.test(fs.readFileSync(f, 'utf8'))).toBe(false);
    }
  });
});

describe('airgap: the scanner discriminates (scripts MAY hold keys)', () => {
  it('scripts/ references the test wallet key env (deployment + verification only)', () => {
    const verify = fs.readFileSync(path.join(SCRIPTS, 'deploy.ts'), 'utf8');
    expect(verify).toContain('TEST_USER_PRIVATE_KEY');
    expect(verify).toContain('privateKeyToAccount'); // scripts are the signing boundary
  });

  it('src/lib/env.ts exposes NO key material accessor', () => {
    const env = fs.readFileSync(path.join(SRC, 'lib', 'env.ts'), 'utf8');
    expect(env).not.toContain('TEST_USER_PRIVATE_KEY');
    expect(env).toContain('NO private key material');
  });
});

describe('airgap: runtime payload inspection', () => {
  const goodPayload: HarborUnsignedPayload = {
    kind: 'deposit',
    to: VAULTS.ATLANTIC_PRIME,
    data: '0x40c10f19000000000000000000000000' as `0x${string}`,
    value: '0',
    chainId: 688689,
    gasEstimate: '185000',
    harborRouteCommitment: computeRouteCommitment({
      user: USER,
      selectedVault: VAULTS.ATLANTIC_PRIME,
      action: 'deposit',
      amountWei: u6(500),
      netApyBps: 818,
      runnerUpHashes: [],
      chainId: 688689,
      calldata: '0x40c10f19' as `0x${string}`,
    }),
    humanSummary: 'Deposit 500000000 units.',
    amountRaw: u6(500).toString(),
  };

  it('accepts a well-formed payload', () => {
    const res = inspectPayloadAirgap(goodPayload);
    expect(res.safe).toBe(true);
    expect(res.violations).toEqual([]);
  });

  it('rejects payloads carrying private key material', () => {
    const res = inspectPayloadAirgap({ ...goodPayload, privateKey: '0xdead' } as unknown as HarborUnsignedPayload);
    expect(res.safe).toBe(false);
    expect(res.violations.join(';')).toContain('privateKey');
  });

  it('rejects payloads carrying signer/walletClient objects', () => {
    for (const key of ['signer', 'walletClient', 'mnemonic', 'seed', 'keystore']) {
      const res = inspectPayloadAirgap({ ...goodPayload, [key]: {} } as unknown as HarborUnsignedPayload);
      expect(res.safe).toBe(false);
    }
  });

  it('rejects non-zero native value (vault actions are valueless ERC-20 ops)', () => {
    const res = inspectPayloadAirgap({ ...goodPayload, value: '1000000000000000000' });
    expect(res.safe).toBe(false);
    expect(res.violations.join(';')).toContain('value');
  });

  it('rejects wrong chainIds', () => {
    const res = inspectPayloadAirgap({ ...goodPayload, chainId: 1 });
    expect(res.safe).toBe(false);
  });

  it('rejects malformed calldata and recipients', () => {
    expect(inspectPayloadAirgap({ ...goodPayload, data: 'not-hex' as `0x${string}` }).safe).toBe(false);
    expect(inspectPayloadAirgap({ ...goodPayload, to: '0x123' as `0x${string}` }).safe).toBe(false);
  });

  it('rejects plans with invalid commitments', () => {
    const plan = {
      action: 'deposit',
      user: USER,
      amount: u6(500),
      horizonDays: 30,
      legs: [goodPayload, goodPayload],
      primaryLegIndex: 1,
      harborRouteCommitment: '0xnot-a-digest',
      selectedVault: VAULTS.ATLANTIC_PRIME,
      selectedProtocol: 'ATLANTIC_PRIME',
      rationale: { summary: 'ok' },
      createdAt: 1,
      parsedFrom: 'x',
    } as unknown as HarborActionPlan;
    const res = inspectPlanAirgap(plan);
    expect(res.safe).toBe(false);
    expect(res.violations.join(';')).toContain('harborRouteCommitment');
  });
});
