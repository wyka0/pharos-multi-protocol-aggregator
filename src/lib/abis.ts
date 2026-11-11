import type { Abi } from 'viem';

/* ========================================================================== */
/* Hand-written minimal ABIs matching contracts/PharosVaultSuite.sol.          */
/* Keeping these in src/ makes the runtime independent of the solc build       */
/* order; tests/verify consistency against the generated artifact.             */
/* ========================================================================== */

export const ERC20_ABI = [
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const satisfies Abi;

export const VAULT_ABI = [
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'assets', type: 'uint256' },
      { name: 'to', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'withdraw',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'netAssets', type: 'uint256' },
      { name: 'to', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'maxWithdraw',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'convertToAssets',
    stateMutability: 'view',
    inputs: [{ name: 'shares', type: 'uint256' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'principalOf',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'sharesOf',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  { type: 'function', name: 'totalAssets', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'totalShares', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'cash', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'debtOwed', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'paused', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'pauseReason', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'entryFeeBps', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'exitFeeBps', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'utilizationWad', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'spotApyBps', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  {
    type: 'function',
    name: 'postDepositApyBps',
    stateMutability: 'view',
    inputs: [{ name: 'dx', type: 'uint256' }],
    outputs: [{ type: 'uint256' }],
  },
  { type: 'function', name: 'asset', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'vaultName', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  {
    type: 'function',
    name: 'capacity',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
] as const satisfies Abi;

export const SUITE_ABI = [
  { type: 'function', name: 'tUSDC', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'harborLend', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'primeStaking', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'rwaTreasury', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'routeAnchor', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  {
    type: 'function',
    name: 'allVaults',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address[3]' }],
  },
  {
    type: 'function',
    name: 'pauseProtocol',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'index', type: 'uint8' },
      { name: 'paused', type: 'bool' },
      { name: 'reason', type: 'string' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'warpAccrual',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'index', type: 'uint8' },
      { name: 'secondsDelta', type: 'uint256' },
    ],
    outputs: [],
  },
] as const satisfies Abi;

export const ANCHOR_ABI = [
  {
    type: 'function',
    name: 'anchorCommitment',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'commitment', type: 'bytes32' },
      { name: 'memo', type: 'string' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'isAnchored',
    stateMutability: 'view',
    inputs: [{ name: 'commitment', type: 'bytes32' }],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'getAnchor',
    stateMutability: 'view',
    inputs: [{ name: 'commitment', type: 'bytes32' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'commitment', type: 'bytes32' },
          { name: 'anchoredBy', type: 'address' },
          { name: 'blockNumber', type: 'uint256' },
          { name: 'timestamp', type: 'uint256' },
          { name: 'memo', type: 'string' },
        ],
      },
    ],
  },
  { type: 'function', name: 'totalAnchors', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  {
    type: 'function',
    name: 'verifyKeccak',
    stateMutability: 'pure',
    inputs: [
      { name: 'encoded', type: 'bytes' },
      { name: 'expected', type: 'bytes32' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const satisfies Abi;
