import type { HarborActionPlan, HarborUnsignedPayload } from './types';

/* ========================================================================== */
/* Non-custodial airgap enforcement (Requirement 02).                          */
/*                                                                            */
/* The agent core NEVER signs and NEVER broadcasts. Enforcement is layered:    */
/*   1. Source airgap   - tests/airgap.test.ts scans src/ for key material,    */
/*                        wallet clients and broadcast APIs (zero hits).       */
/*   2. Runtime airgap  - every HarborActionPlan passes through                */
/*                        assertAirgappedPlan() below before leaving the core. */
/*   3. Output shape    - the only executable artifact the core produces is an */
/*                        unsigned ABI-encoded payload (to/data/value/chainId) */
/*                        for the USER's wallet to review and sign.            */
/* ========================================================================== */

/** Patterns that must NEVER appear in src/ (enforced by the test suite).
 *  Note: the UI's useWriteContract() is the USER's wallet action and is
 *  deliberately allowed - the agent core itself never broadcasts. */
export const FORBIDDEN_SOURCE_PATTERNS: RegExp[] = [
  /private[_-]?key/i,
  /mnemonic/i,
  /signTransaction/i,
  /signTypedData/i,
  /signMessage\b/i,
  /createWalletClient/i,
  /sendTransaction/i,
  /deployContract\(/i,
];

/** Object keys that must never appear inside a prepared payload/plan. */
const FORBIDDEN_PAYLOAD_KEYS = [
  'privatekey',
  'private_key',
  'mnemonic',
  'seed',
  'signer',
  'walletclient',
  'keystore',
  'signature',
];

function findForbiddenKeys(value: unknown, path: string, hits: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => findForbiddenKeys(v, `${path}[${i}]`, hits));
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_PAYLOAD_KEYS.includes(k.toLowerCase())) {
        hits.push(`${path}.${k}`);
      }
      findForbiddenKeys(v, `${path}.${k}`, hits);
    }
  }
}

export interface AirgapCheckResult {
  safe: boolean;
  violations: string[];
}

/** Deep-scan a payload for key material / signature objects. */
export function inspectPayloadAirgap(payload: HarborUnsignedPayload): AirgapCheckResult {
  const violations: string[] = [];
  findForbiddenKeys(payload, 'payload', violations);
  if (payload.value !== '0') {
    violations.push('payload.value must be "0" (vault actions never carry native value)');
  }
  if (typeof payload.chainId !== 'number' || payload.chainId !== 688689) {
    violations.push(`payload.chainId must be 688689 (got ${String(payload.chainId)})`);
  }
  if (!payload.data.startsWith('0x')) {
    violations.push('payload.data must be ABI-encoded hex');
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(payload.to)) {
    violations.push('payload.to must be a valid contract address');
  }
  return { safe: violations.length === 0, violations };
}

/** Deep-scan a full action plan (all legs + commitment). */
export function inspectPlanAirgap(plan: HarborActionPlan): AirgapCheckResult {
  const violations: string[] = [];
  for (const [i, leg] of plan.legs.entries()) {
    const res = inspectPayloadAirgap(leg);
    for (const v of res.violations) violations.push(`leg[${i}]: ${v}`);
  }
  findForbiddenKeys(plan.rationale, 'rationale', violations);
  if (!/^0x[0-9a-fA-F]{64}$/.test(plan.harborRouteCommitment)) {
    violations.push('harborRouteCommitment must be a keccak256 hex digest');
  }
  return { safe: violations.length === 0, violations };
}

/** Runtime gate used by the aggregator before returning any plan. */
export function assertAirgappedPlan(plan: HarborActionPlan): HarborActionPlan {
  const res = inspectPlanAirgap(plan);
  if (!res.safe) {
    throw new Error(`airgap violation: ${res.violations.join('; ')}`);
  }
  return plan;
}
