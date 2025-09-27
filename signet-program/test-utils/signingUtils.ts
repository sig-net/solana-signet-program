/**
 * Common signing utilities for tests
 *
 * This module provides reusable functions for:
 * - Creating unique sign arguments with identifiable payloads
 * - Calling sign functions via CPI proxy or direct calls
 * - Waiting for signature responses from the subscriber
 * - Logging payload descriptions for easy debugging
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ProxyTestCpi } from "../target/types/proxy_test_cpi";
import { ChainSignatures } from "../target/types/chain_signatures";
import { contracts, chainAdapters } from "signet.js";

export interface SignArgs {
  payload: number[];
  keyVersion: number;
  path: string;
  algo: string;
  dest: string;
  params: string;
}

// Unique payload prefixes for easy identification in logs/subscriber
const PAYLOAD_PREFIXES = {
  CPI_TEST: 0x10, // 16
  WALLET_TEST: 0x20, // 32
  CONFIG_TEST: 0x30, // 48
  CONCURRENT_TEST: 0x40, // 64
} as const;

/**
 * Creates unique sign arguments with identifiable payloads
 */
export function createSignArgs(
  testType: keyof typeof PAYLOAD_PREFIXES,
  pathSuffix: string = "",
  offset: number = 0
): SignArgs {
  const prefix = PAYLOAD_PREFIXES[testType];

  return {
    payload: Array.from({ length: 32 }, (_, i) => {
      if (i === 0) return prefix; // First byte identifies test type
      if (i === 1) return offset; // Second byte for test iteration/offset
      return (i + offset) % 256; // Remaining bytes with pattern
    }),
    keyVersion: 0,
    path: pathSuffix
      ? `test-${testType.toLowerCase()}-path-${pathSuffix}`
      : `test-${testType.toLowerCase()}-path`,
    algo: "secp256k1",
    dest: "ethereum",
    params: "{}",
  };
}

/**
 * Call sign function via CPI proxy
 */
export async function callProxySign(
  proxyProgram: Program<ProxyTestCpi>,
  signArgs: SignArgs,
  feePayer: anchor.web3.PublicKey,
  eventAuthorityPda: anchor.web3.PublicKey
): Promise<string> {
  return proxyProgram.methods
    .callSign(
      signArgs.payload,
      signArgs.keyVersion,
      signArgs.path,
      signArgs.algo,
      signArgs.dest,
      signArgs.params
    )
    .accounts({
      feePayer,
      eventAuthority: eventAuthorityPda,
    })
    .rpc();
}

/**
 * Call sign function directly on the main program
 */
export async function callDirectSign(
  program: Program<ChainSignatures>,
  signArgs: SignArgs
): Promise<string> {
  return program.methods
    .sign(
      signArgs.payload,
      signArgs.keyVersion,
      signArgs.path,
      signArgs.algo,
      signArgs.dest,
      signArgs.params
    )
    .rpc();
}

/**
 * Wait for signature response using signet.js
 */
export async function waitForSignatureResponse(
  signArgs: SignArgs,
  signetSolContract: contracts.solana.ChainSignatureContract,
  evmChainAdapter: chainAdapters.evm.EVM,
  requesterPublicKey: anchor.web3.PublicKey,
  afterSignature?: string
): Promise<{
  isValid: boolean;
  signature: {
    r: string;
    s: string;
    v: number;
  };
  derivedAddress: string;
}> {
  const requestId = signetSolContract.getRequestId(
    {
      payload: signArgs.payload,
      path: signArgs.path,
      key_version: signArgs.keyVersion,
    },
    {
      algo: signArgs.algo,
      dest: signArgs.dest,
      params: signArgs.params,
    }
  );

  const derivedAddress = await evmChainAdapter.deriveAddressAndPublicKey(
    requesterPublicKey.toString(),
    signArgs.path
  );

  const result = await signetSolContract.pollForRequestId({
    requestId,
    payload: signArgs.payload,
    path: signArgs.path,
    afterSignature: afterSignature || "",
    options: {
      retryCount: 30,
      delay: 1000,
    },
  });

  if (!result) {
    throw new Error(`No signature response found for request ${requestId}`);
  }

  if ('error' in result) {
    throw new Error(`Signature error: ${result.error}`);
  }

  return {
    isValid: true,
    signature: result,
    derivedAddress: derivedAddress.address,
  };
}

/**
 * Get payload type description for logging
 */
export function getPayloadDescription(payload: number[]): string {
  if (payload.length === 0) return "empty";

  const prefix = payload[0];
  const offset = payload[1] || 0;

  for (const [type, value] of Object.entries(PAYLOAD_PREFIXES)) {
    if (value === prefix) {
      return `${type}_${offset}`;
    }
  }

  return `unknown_${prefix}_${offset}`;
}
