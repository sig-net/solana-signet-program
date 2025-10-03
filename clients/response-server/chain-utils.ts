/**
 * Utilities for chain-specific operations
 */

export enum SerializationFormat {
  Borsh = 0,
  ABI = 1,
}

/**
 * Infer serialization format from CAIP-2 chain ID
 *
 * @param caip2Id - CAIP-2 chain identifier (e.g., "eip155:1", "solana:mainnet")
 * @returns SerializationFormat - Borsh for Solana, ABI for EVM chains
 *
 * @example
 * getSerializationFormat("eip155:1") // SerializationFormat.ABI
 * getSerializationFormat("eip155:11155111") // SerializationFormat.ABI
 * getSerializationFormat("solana:mainnet") // SerializationFormat.Borsh
 */
export function getSerializationFormat(caip2Id: string): SerializationFormat {
  const [namespace] = caip2Id.split(':');

  switch (namespace.toLowerCase()) {
    case 'eip155': // Ethereum and EVM-compatible chains
    case 'bip122': // Bitcoin (would use ABI-like encoding)
    case 'cosmos': // Cosmos chains (would use ABI-like encoding)
      return SerializationFormat.ABI;

    case 'solana': // Solana chains
      return SerializationFormat.Borsh;

    default:
      throw new Error(`Unsupported chain namespace: ${namespace}`);
  }
}

/**
 * Extract SLIP-44 coin type from CAIP-2 ID for EIP-155 chains
 *
 * @param caip2Id - CAIP-2 chain identifier
 * @returns SLIP-44 coin type number
 *
 * @example
 * getSlip44FromCaip2("eip155:1") // 60 (Ethereum mainnet)
 * getSlip44FromCaip2("eip155:11155111") // 60 (Sepolia testnet)
 */
export function getSlip44FromCaip2(caip2Id: string): number {
  const [namespace, reference] = caip2Id.split(':');

  if (namespace === 'eip155') {
    // All EVM chains use SLIP-44 coin type 60
    return 60;
  }

  throw new Error(`Cannot extract SLIP-44 from chain: ${caip2Id}`);
}
