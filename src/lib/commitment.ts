import { encodeAbiParameters, keccak256, toBytes, toHex, type Address, type Hex } from 'viem';
import type { CandidateEvaluation } from './types';
import { candidateDescriptor } from './adapters/projection';

/* ========================================================================== */
/* Cryptographic Multi-Venue Quote-to-Payload Commitment (Innovation #2).      */
/*                                                                            */
/* harborRouteCommitment = keccak256(abi.encode(                                */
/*   user, selectedVault, action, amountWei, netApyBps,                        */
/*   runnerUpHashes[], chainId, calldata))                                     */
/*                                                                            */
/* This binds the unsigned payload presented to the wallet to the exact        */
/* multi-venue comparison table shown in the UI: any tampering with the        */
/* selected vault, amount, calldata, chainId, or the runner-up table changes   */
/* the commitment, and verification fails before signing.                      */
/* ========================================================================== */

export type RouteAction = 'deposit' | 'withdraw';

export interface RouteCommitmentInput {
  user: Address;
  selectedVault: Address;
  action: RouteAction;
  amountWei: bigint;
  netApyBps: number;
  runnerUpHashes: Hex[];
  chainId: number;
  calldata: Hex;
}

const COMMITMENT_TYPES = [
  { type: 'address' },
  { type: 'address' },
  { type: 'bytes32' },
  { type: 'uint256' },
  { type: 'uint256' },
  { type: 'bytes32[]' },
  { type: 'uint256' },
  { type: 'bytes' },
] as const;

export function actionToBytes32(action: RouteAction): Hex {
  return keccak256(toBytes(action));
}

export function computeRouteCommitment(input: RouteCommitmentInput): Hex {
  const encoded = encodeAbiParameters(COMMITMENT_TYPES, [
    input.user,
    input.selectedVault,
    actionToBytes32(input.action),
    input.amountWei,
    BigInt(Math.round(input.netApyBps)),
    input.runnerUpHashes.length > 0 ? input.runnerUpHashes : [keccak256(toBytes('harbor-no-runner-ups'))],
    BigInt(input.chainId),
    input.calldata,
  ]);
  return keccak256(encoded);
}

/** ABI-encoded preimage so contracts (AggregatorRouteAnchor.verifyKeccak) can
 *  re-derive the commitment on-chain. */
export function encodeCommitmentPreimage(input: RouteCommitmentInput): Hex {
  return encodeAbiParameters(COMMITMENT_TYPES, [
    input.user,
    input.selectedVault,
    actionToBytes32(input.action),
    input.amountWei,
    BigInt(Math.round(input.netApyBps)),
    input.runnerUpHashes.length > 0 ? input.runnerUpHashes : [keccak256(toBytes('harbor-no-runner-ups'))],
    BigInt(input.chainId),
    input.calldata,
  ]);
}

export function verifyRouteCommitment(input: RouteCommitmentInput, expected: Hex): boolean {
  return computeRouteCommitment(input) === expected.toLowerCase() as Hex;
}

/** Hash descriptor of one comparison-table row (feeds runnerUpHashes). */
export function candidateHash(candidate: CandidateEvaluation): Hex {
  return keccak256(toBytes(candidateDescriptor(candidate)));
}

/** Hash of auxiliary calldata (e.g. the ERC-20 approve leg). */
export function auxCalldataHash(data: Hex): Hex {
  return keccak256(data);
}

/** Stable hex short form for UI display. */
export function shortCommitment(commitment: Hex, chars = 10): string {
  return `${commitment.slice(0, 2 + chars)}...${commitment.slice(-4)}`;
}

export function bytesToHex(b: Uint8Array): Hex {
  return toHex(b);
}
