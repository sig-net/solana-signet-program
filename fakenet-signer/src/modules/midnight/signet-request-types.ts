/**
 * The fakenet responder's flat view of a Midnight signet signing request,
 * decoded from a client contract's SignBidirectionalEvent record. Transaction
 * re-assembly happens in @sig-net/midnight's shared builder
 * (signBidirectionalEventToUnsignedEVMTransaction), never from this view:
 * these fields exist for logging, routing and key derivation only.
 */

/** EVM gas parameters read from the request record. */
export interface EvmGasParams {
  /** Target EVM contract address (20 bytes). */
  evmTo: Uint8Array;
  /** EVM chain ID. */
  evmChainId: bigint;
  /** EVM transaction nonce. */
  evmNonce: bigint;
  /** Gas limit. */
  evmGasLimit: bigint;
  /** Max fee per gas (wei). */
  evmMaxFee: bigint;
  /** Max priority fee per gas (wei). */
  evmPriorityFee: bigint;
  /** ETH value to send (wei). */
  evmValue: bigint;
}

/**
 * Calldata fields read from the request record: the flat logging/inspection
 * view of the word calldata. Words are ABI-ready big-endian 32-byte words,
 * stored exactly as broadcast (selector || words, verbatim).
 */
export interface CalldataFields {
  /** The 4-byte function selector as 0x hex; absent when the tx has no calldata. */
  selector?: string;
  /** The real (used) ABI-ready 32-byte calldata words, in order. */
  words: Uint8Array[];
}

/** A signing request read from a client contract's signet ledger record. */
export interface SigningRequest {
  /** Contract address — the predecessor (from ContractCall.address). Unforgeable. */
  predecessor: string;
  /** Request ID — the Map key, computed as persistentHash of the full record. */
  requestId: Uint8Array;
  /** Per-request nonce value — ensures identical txs produce different request IDs. */
  nonce: bigint;
  /** EVM gas/tx parameters. */
  evmParams: EvmGasParams;
  /** Calldata fields (selector + words). */
  calldata: CalldataFields;
  /** CAIP-2 chain identifier, e.g. "eip155:11155111". */
  caip2Id: string;
  /** MPC key version. */
  keyVersion: number;
  /** Derivation path — controlled by the contract. */
  path: Uint8Array;
  /** Signing algorithm, e.g. "ecdsa". */
  algo: string;
  /** Destination type, e.g. "ethereum". */
  dest: string;
  /** Additional parameters (contract-specific). */
  params: Uint8Array;
  /** Schema for deserializing the EVM tx output. */
  outputDeserializationSchema: Uint8Array;
  /** Schema for serializing the response back. */
  respondSerializationSchema: Uint8Array;
}
