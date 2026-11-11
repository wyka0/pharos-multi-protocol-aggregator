/**
 * Compiles contracts/PharosVaultSuite.sol with solc-js and emits
 * src/generated/suite.json (ABI + bytecode for every contract). Deterministic
 * output tracked in git so runtime never needs the compiler.
 *
 * Run: npm run compile
 */
import fs from 'node:fs';
import path from 'node:path';
import solc from 'solc';

const root = path.resolve(__dirname, '..');
const sourcePath = path.join(root, 'contracts', 'PharosVaultSuite.sol');
const outPath = path.join(root, 'src', 'generated', 'suite.json');

const source = fs.readFileSync(sourcePath, 'utf8');

const input = {
  language: 'Solidity',
  sources: { 'PharosVaultSuite.sol': { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input))) as {
  errors?: Array<{ severity: string; formattedMessage: string }>;
  contracts?: Record<string, Record<string, { abi: unknown; evm: { bytecode: { object: string } } }>>;
};

const errors = (output.errors ?? []).filter((e) => e.severity === 'error');
if (errors.length > 0) {
  console.error(errors.map((e) => e.formattedMessage).join('\n'));
  process.exit(1);
}

const warnings = (output.errors ?? []).filter((e) => e.severity === 'warning');
if (warnings.length > 0) {
  console.warn(warnings.map((e) => e.formattedMessage).join('\n'));
}

const file = output.contracts?.['PharosVaultSuite.sol'];
if (!file || !file['PharosVaultSuite']) {
  console.error('PharosVaultSuite not found in solc output');
  process.exit(1);
}

const wanted = ['PharosVaultSuite', 'HarborLendVault', 'AtlanticPrimeStaking', 'PharosRwaTreasury', 'AggregatorRouteAnchor', 'SuiteToken'];
const contracts: Record<string, { abi: unknown; bytecode?: string }> = {};
for (const name of wanted) {
  const c = file[name];
  if (!c) {
    console.error(`Missing contract in compilation output: ${name}`);
    process.exit(1);
  }
  contracts[name] = {
    abi: c.abi,
    ...(name === 'PharosVaultSuite' ? { bytecode: `0x${c.evm.bytecode.object}` } : {}),
  };
}

const artifact = {
  contractName: 'PharosVaultSuite',
  compiler: { solc: (solc.version() as string) ?? 'unknown', settings: 'optimizer enabled, 200 runs' },
  abi: contracts['PharosVaultSuite'].abi,
  bytecode: contracts['PharosVaultSuite'].bytecode,
  contracts,
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(
  `PharosVaultSuite compiled -> ${path.relative(root, outPath)} (bytecode ${Math.floor((artifact.bytecode?.length ?? 0) / 2)} bytes, ${Object.keys(contracts).length} ABIs)`,
);
