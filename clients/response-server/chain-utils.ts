/**
 * Utilities for chain-specific operations
 */

export enum SerializationFormat {
  Borsh = 0,
  ABI = 1,
}

/**
 * Extract namespace from CAIP-2 chain ID
 *
 * @param caip2Id - CAIP-2 chain identifier (e.g., "eip155:1", "solana:mainnet")
 * @returns namespace - The chain namespace (e.g., "eip155", "solana")
 *
 * @example
 * getNamespaceFromCaip2("eip155:1") // "eip155"
 * getNamespaceFromCaip2("solana:mainnet") // "solana"
 */
export function getNamespaceFromCaip2(caip2Id: string): string {
  const [namespace] = caip2Id.split(':');
  if (!namespace) {
    throw new Error(`Invalid CAIP-2 ID: ${caip2Id}`);
  }
  return namespace.toLowerCase();
}

/**
 * Get serialization format from CAIP-2 chain ID
 * Multiple chains can share the same serialization format
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
  const namespace = getNamespaceFromCaip2(caip2Id);

  switch (namespace) {
    case 'eip155':
      return SerializationFormat.ABI;
    case 'solana':
      return SerializationFormat.Borsh;
    default:
      throw new Error(`Unsupported chain namespace: ${namespace}`);
  }
}
