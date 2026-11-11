/**
 * Strict secret audit (semantics-aware):
 *
 *  1. .env.local / .env* are git-ignored (except .env.example).
 *  2. The REAL secret bytes from .env.local appear in NO tracked file
 *     (exact-match scan; the key value itself is never printed).
 *  3. No key-shaped literal assignments in tracked files
 *     (privateKey = 0x… / PRIVATE_KEY = 0x… / mnemonic = …), except the
 *     all-zero placeholder in .env.example.
 *  4. Bare 64-hex literals are class-dependent, because private keys and
 *     PUBLIC chain data (tx hashes, keccak commitments) share a shape:
 *       - src/generated/**  : compiled bytecode/ABI -> exempt (still scanned by 2)
 *       - tests/**          : only uniform sentinel vectors (0x1111…, 0x2222…)
 *       - *.md / evidence/**: only clearly-labeled PUBLIC chain data
 *                             (tx hashes, commitments, explorer URLs) or
 *                             unbounded windows inside longer public hex
 *                             runs (raw calldata, compiled bytecode)
 *       - everything else   : forbidden outright
 *  5. The scanner self-tests on every run: synthetic key canaries must be
 *     flagged and labeled public data must pass, or the audit fails itself.
 *
 * Run: npm run audit:secrets
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import './env';

const root = path.resolve(__dirname, '..');

const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'out', '.data', 'coverage']);

// --- Patterns are assembled from fragments so this scanner's own source can
// --- never match them (avoids self-triggering false positives).
const HEX64 = '0x[a-fA-F0-9]{64}';
const HEX64_RE = new RegExp(HEX64); // non-global: first occurrence per line is enough
// A key-shaped literal assignment: privateKey = "0x…" / PRIVATE_KEY=0x… / mnemonic = 0x…
const KEY_ASSIGN_RE = new RegExp(
  '(?:\\bprivate[A-Za-z]*[Kk]ey\\b|PRIVATE_' + 'KEY\\b|\\bmnemonic\\b|\\bsecret\\b)\\s*[:=]\\s*["\x27]?\\s*' + HEX64,
);
// Proof that .env.local actually holds a usable key (checked on .env.local only).
const ENV_KEY_PRESENT_RE = new RegExp('TEST_USER' + '_PRIVATE_KEY=0x[a-fA-F0-9]{64}');
// Uniform sentinel vectors (0x1111…1111, 0x2222…2222) are opaque test fixtures.
const SENTINEL_RE = /^0x([0-9a-fA-F])\1{63}$/;
// A KEY-shaped hex literal is BOUNDED: quote/space on both sides. Windows inside
// longer public hex runs (calldata, bytecode) are unbounded and are NOT keys.
const BOUNDED_HEX64_RE = /(^|[^a-zA-Z0-9_])(0x[a-fA-F0-9]{64})(?![a-fA-F0-9])/;
// Public chain-data labels for docs/evidence (camelCase-aware, token match).
const PUBLIC_LABEL_TOKENS = ['tx', 'txhash', 'txurl', 'deploytx', 'anchor', 'commitment', 'hash', 'digest', 'calldata', 'data', 'route', 'proof'];
const hasPublicLabel = (line: string): boolean => {
  const tokens = line.toLowerCase().split(/[^a-z0-9]+/);
  return tokens.some((t) => PUBLIC_LABEL_TOKENS.some((l) => t.includes(l)));
};

type FileClass = 'envExample' | 'generated' | 'tests' | 'docs' | 'code';

function classify(rel: string): FileClass {
  const norm = rel.split(path.sep).join('/');
  if (norm === '.env.example') return 'envExample';
  if (norm.startsWith('src/generated/')) return 'generated';
  if (norm.startsWith('tests/')) return 'tests';
  if (norm.endsWith('.md') || norm.startsWith('evidence/')) return 'docs';
  return 'code';
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(p, out);
    } else {
      out.push(p);
    }
  }
  return out;
}

/** Parse a dotenv-style file into raw KEY -> VALUE pairs (no printing). */
function readEnvPairs(file: string): Map<string, string> {
  const pairs = new Map<string, string>();
  if (!fs.existsSync(file)) return pairs;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
    if (m && m[2] !== undefined) pairs.set(m[1], m[2].trim().replace(/^["']|["']$/g, ''));
  }
  return pairs;
}

let violations = 0;
const fail = (msg: string) => {
  console.error(`[FAIL] ${msg}`);
  violations += 1;
};

// ---------------------------------------------------------------------------
// 1. git ignore check
// ---------------------------------------------------------------------------
try {
  execSync('git check-ignore .env.local', { cwd: root, stdio: 'pipe' });
  console.log('[ok] .env.local is git-ignored');
} catch {
  fail('.env.local is NOT git-ignored');
}

// ---------------------------------------------------------------------------
// 2. REAL secret bytes must appear in NO tracked file (exact-match scan).
//    The definitive leak check: shape heuristics can misfire on public hashes,
//    but the actual key bytes can never legitimately appear outside .env.local.
// ---------------------------------------------------------------------------
const envPairs = readEnvPairs(path.join(root, '.env.local'));
const secrets: string[] = [];
for (const [name, value] of envPairs) {
  if (value.length >= 16 && /PRIVATE|MNEMONIC|SEED|SECRET|KEY/i.test(name)) secrets.push(value);
}

const files = walk(root).filter((f) => !f.endsWith('.env.local') && !f.endsWith('.env'));
if (secrets.length === 0) {
  console.log('[warn] no key-shaped secrets found in .env.local (deploy/verify will need one)');
} else {
  let leaked = 0;
  for (const file of files) {
    const lower = fs.readFileSync(file, 'utf8').toLowerCase();
    for (const secret of secrets) {
      const bare = secret.toLowerCase().replace(/^0x/, '');
      if (lower.includes(bare)) leaked += 1;
    }
  }
  if (leaked === 0) {
    console.log(`[ok] real secret bytes absent from all tracked files (${secrets.length} secret(s) checked, values never printed)`);
  } else {
    fail(`real secret bytes found in ${leaked} tracked file(s)`);
  }
}

// ---------------------------------------------------------------------------
// 3 + 4. per-file shape scan (class-dependent)
// ---------------------------------------------------------------------------
/** Per-line scan. Returns human-readable problem strings (empty = clean). */
function scanLine(line: string, cls: FileClass): string[] {
  const problems: string[] = [];
  const zeroPlaceholder = /0x0{64}/.test(line);

  // 3. key-shaped literal assignments (placeholder zeros in .env.example ok)
  if (KEY_ASSIGN_RE.test(line) && !(cls === 'envExample' && zeroPlaceholder)) {
    problems.push('private-key literal assignment');
    return problems;
  }

  // 4. bare 64-hex literals, class-dependent
  if (cls === 'generated' || cls === 'envExample') return problems; // bytecode / placeholder

  if (cls === 'code') {
    if (HEX64_RE.test(line)) problems.push('64-hex literal in code');
    return problems;
  }

  // tests/docs: only KEY-SHAPED (bounded) tokens are scrutinized; windows
  // inside longer public hex runs (calldata, bytecode) are not keys.
  const m = BOUNDED_HEX64_RE.exec(line);
  if (m && m[2]) {
    const boundary = m[1] ?? '';
    const hexStart = m.index + boundary.length;
    const before = line.slice(Math.max(0, hexStart - 12), hexStart);
    const isExplorerUrl = /tx\/$|address\/$/.test(before);
    if (cls === 'tests') {
      if (!SENTINEL_RE.test(m[2])) problems.push('non-sentinel 64-hex literal in tests');
    } else if (!isExplorerUrl && !hasPublicLabel(line)) {
      problems.push('unlabeled 64-hex in docs/evidence');
    }
  }
  return problems;
}

for (const file of files) {
  const rel = path.relative(root, file);
  if (!/\.(ts|tsx|js|jsx|json|md|sol|mjs|css|example)$/.test(rel)) continue;
  const cls = classify(rel);
  const lines = fs.readFileSync(file, 'utf8').split('\n');

  lines.forEach((line, i) => {
    const where = `${rel}:${i + 1}`;
    for (const problem of scanLine(line, cls)) fail(`${problem} at ${where}`);
  });
}

// ---------------------------------------------------------------------------
// 5. scanner self-test: synthetic canaries must be classified exactly as
//    designed, so the audit proves on every run that it still detects leaks.
// ---------------------------------------------------------------------------
const canaries: Array<{ line: string; cls: FileClass; expectFail: boolean }> = [
  { line: `const privateKey = '0x${'ab'.repeat(32)}';`, cls: 'code', expectFail: true },
  { line: `PRIVATE_KEY=0x${'cd'.repeat(32)}`, cls: 'code', expectFail: true },
  { line: `Route proof: 0x${'ef'.repeat(32)}`, cls: 'docs', expectFail: false },
  { line: `unlabeled value 0x${'12'.repeat(32)}`, cls: 'docs', expectFail: true },
  { line: `vector '0x${'11'.repeat(32)}' as Hex`, cls: 'tests', expectFail: false },
  { line: `non-sentinel '0x${'ab'.repeat(32)}' fixture`, cls: 'tests', expectFail: true },
];
let canaryOk = true;
for (const canary of canaries) {
  const detected = scanLine(canary.line, canary.cls).length > 0;
  if (detected !== canary.expectFail) {
    fail(`scanner self-test canary misclassified (${canary.cls}, expected ${canary.expectFail ? 'FAIL' : 'PASS'})`);
    canaryOk = false;
  }
}
if (canaryOk) console.log(`[ok] scanner self-test passed (${canaries.length} canaries)`);


// ---------------------------------------------------------------------------
// 6. the key must exist ONLY in .env.local
// ---------------------------------------------------------------------------
const envLocal = path.join(root, '.env.local');
const hasKey = fs.existsSync(envLocal) && ENV_KEY_PRESENT_RE.test(fs.readFileSync(envLocal, 'utf8'));
console.log(hasKey ? '[ok] key material present only in .env.local' : '[warn] no TEST_USER_PRIVATE_KEY in .env.local (deploy/verify will need it)');

if (violations > 0) {
  console.error(`\nSECRET AUDIT FAILED with ${violations} violation(s).`);
  process.exit(1);
}
console.log('\nSECRET AUDIT PASSED: zero key material in tracked files.');
