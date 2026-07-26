export const CONFIG = {
  EPSILON_DERIVATION_PREFIX: 'sig.network v2.0.0 epsilon derivation',
  // Only the Substrate handlers still speak the v1 comma scheme: the signet
  // pallet derives counterparty addresses with this exact prefix, so bump it
  // only together with the pallet. Midnight tx-signing derives through the
  // signet library's v2 colon scheme (deriveEpsilon in @sig-net/midnight)
  // and no longer uses this prefix.
  EPSILON_DERIVATION_PREFIX_V1: 'sig.network v1.0.0 epsilon derivation',
  SOLANA_CAIP2_ID: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  SOLANA_RESPOND_BIDIRECTIONAL_PATH: 'solana response key',
  SECP256K1_N:
    '0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141',
  POLL_INTERVAL_MS: 5000,
  TX_TIMEOUT_MS: 1200000,
  RPC_TIMEOUT_MS: 30_000,
  BITCOIN_DEFAULT_CONFIRMATIONS: 1,
  KEY_VERSION: 1,
} as const;
