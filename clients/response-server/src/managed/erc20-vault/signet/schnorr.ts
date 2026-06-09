/**
 * Schnorr Signature on Jubjub Curve
 *
 * Implements Schnorr signing and verification using the Jubjub curve
 * embedded in BLS12-381, via Midnight's compact-runtime EC operations.
 *
 * Protocol:
 *   Sign(sk, requestId, outputData):
 *     pk = sk * G
 *     k  = Hash(sk, requestId, attempt) % JUBJUB_ORDER   (deterministic nonce)
 *     R  = k * G
 *     h_full = Hash(R, pk, requestId, Hash(outputData)) as Field
 *     h  = h_full % JUBJUB_ORDER           (reduced challenge)
 *     s  = (k + h * sk) % JUBJUB_ORDER
 *     Return (R, s, h, quotient)
 *
 *   Verify(pk, requestId, outputData, R, s, h, quotient):
 *     h_full = Hash(R, pk, requestId, Hash(outputData)) as Field
 *     Check: h + quotient * JUBJUB_ORDER == h_full
 *     Check: s * G == R + h * pk
 *
 * The challenge reduction (h, quotient) is needed because Midnight's
 * EC operations reject scalars >= JUBJUB_ORDER.
 */

import {
  ecMulGenerator,
  ecMul,
  ecAdd,
  persistentHash,
  CompactTypeJubjubPoint,
  CompactTypeBytes,
  CompactTypeVector,
} from '@midnight-ntwrk/compact-runtime';
import type { JubjubPoint } from '@midnight-ntwrk/compact-runtime';

// ---- Constants ----

/** Jubjub curve scalar field order (group order of the generator). */
export const JUBJUB_ORDER = 6554484396890773809930967563523245729705921265872317281365359162392183254199n;

/** BLS12-381 scalar field order (the Field type modulus). */
export const BLS_ORDER = 52435875175126190479447740508185965837690552500527637822603658699938581184513n;

// ---- Type helpers ----

const bytes32Type = new CompactTypeBytes(32);
const bytes4096Type = new CompactTypeBytes(4096);
const vec2x32Type = new CompactTypeVector(2, bytes32Type);
const vec3x32Type = new CompactTypeVector(3, bytes32Type);
const vec4x32Type = new CompactTypeVector(4, bytes32Type);

// ---- Scalar/bytes conversion ----

/**
 * Convert a bigint to exactly 32 bytes (little-endian).
 * Matches Compact's `Field as Bytes<32>` encoding.
 */
export function bigintToBytes32(n: bigint): Uint8Array {
  const buf = new Uint8Array(32);
  let v = n < 0n ? n + BLS_ORDER : n;
  for (let i = 0; i < 32; i++) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return buf;
}

/**
 * Convert a Uint8Array (little-endian) to a bigint.
 * Matches Compact's `Bytes<32> as Field` interpretation.
 */
export function bytesToBigint(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    result = (result << 8n) | BigInt(bytes[i]);
  }
  return result;
}

// ---- Schnorr signature ----

/** Result of a Schnorr signature. */
export interface SchnorrSignature {
  /** Nonce commitment R = k * G. */
  R: JubjubPoint;
  /** Signature scalar s = (k + h * sk) mod JUBJUB_ORDER. */
  s: bigint;
  /** Reduced challenge h = hash_full mod JUBJUB_ORDER. */
  challengeH: bigint;
  /** Quotient of the challenge reduction (hash_full - h) / JUBJUB_ORDER. */
  challengeQuotient: bigint;
}

/**
 * Compute the Schnorr challenge hash (raw, possibly >= BLS_ORDER).
 *
 * This MUST match the circuit's computation exactly:
 *   persistentHash<Vector<4, Bytes<32>>>([
 *     persistentHash<JubjubPoint>(sigR),
 *     persistentHash<JubjubPoint>(pk),
 *     requestId,
 *     persistentHash<Bytes<4096>>(outputData)
 *   ])
 * interpreted as a little-endian integer (matching Compact's `Bytes<32> as Field`).
 *
 * NOTE: The returned value may exceed BLS_ORDER. The caller must check and
 * retry with a different nonce if so, because Compact's `as Field` rejects overflow.
 */
export function computeChallenge(
  R: JubjubPoint,
  pk: JubjubPoint,
  requestId: Uint8Array,
  outputData: Uint8Array,
): bigint {
  const rHash = persistentHash(CompactTypeJubjubPoint, R);
  const pkHash = persistentHash(CompactTypeJubjubPoint, pk);
  const outputDataHash = persistentHash(bytes4096Type, outputData);

  const hashBytes = persistentHash(vec4x32Type, [rHash, pkHash, requestId, outputDataHash]);
  return bytesToBigint(hashBytes); // LE interpretation, matches Compact's `as Field`
}

/**
 * Sign a message with Schnorr on the Jubjub curve.
 *
 * The nonce is derived deterministically with an attempt counter. If the
 * challenge hash (interpreted as LE integer) exceeds BLS_ORDER, the circuit's
 * `as Field` cast would reject it. In that case we increment the counter and
 * retry with a different nonce. ~25% of hashes fit, so average ~4 attempts.
 *
 * @param sk - Jubjub private key scalar (must be < JUBJUB_ORDER)
 * @param requestId - The request ID (32 bytes)
 * @param outputData - The EVM return data (4096 bytes, zero-padded)
 * @returns Schnorr signature (R, s, challengeH, challengeQuotient)
 */
export function schnorrSign(
  sk: bigint,
  requestId: Uint8Array,
  outputData: Uint8Array,
): SchnorrSignature {
  if (sk <= 0n || sk >= JUBJUB_ORDER) {
    throw new Error('Private key must be in (0, JUBJUB_ORDER)');
  }

  const pk = ecMulGenerator(sk);

  for (let attempt = 0; attempt < 256; attempt++) {
    // Deterministic nonce with attempt counter: k = Hash(sk, requestId, attempt) % JUBJUB_ORDER
    const counterBytes = bigintToBytes32(BigInt(attempt));
    const kSeed = persistentHash(vec3x32Type, [bigintToBytes32(sk), requestId, counterBytes]);
    const k = (bytesToBigint(kSeed) % JUBJUB_ORDER) || 1n; // ensure k != 0
    const R = ecMulGenerator(k);

    // Compute challenge hash (raw LE bigint, may exceed BLS_ORDER)
    const hFull = computeChallenge(R, pk, requestId, outputData);

    // Compact's `as Field` rejects values >= BLS_ORDER — retry with different nonce
    if (hFull >= BLS_ORDER) continue;

    const challengeH = hFull % JUBJUB_ORDER;
    const challengeQuotient = (hFull - challengeH) / JUBJUB_ORDER;

    // Signature scalar: s = (k + h * sk) mod JUBJUB_ORDER
    const s = ((k + challengeH * sk) % JUBJUB_ORDER + JUBJUB_ORDER) % JUBJUB_ORDER;

    return { R, s, challengeH, challengeQuotient };
  }

  throw new Error('Failed to find valid Schnorr nonce after 256 attempts (extremely unlikely)');
}

/**
 * Verify a Schnorr signature on the Jubjub curve.
 *
 * Matches the circuit's verification logic:
 *   1. h + quotient * JUBJUB_ORDER == hFull
 *   2. s * G == R + h * pk
 *
 * @returns true if the signature is valid
 */
export function schnorrVerify(
  pk: JubjubPoint,
  requestId: Uint8Array,
  outputData: Uint8Array,
  sig: SchnorrSignature,
): boolean {
  // Recompute full challenge
  const hFull = computeChallenge(sig.R, pk, requestId, outputData);

  // The hash must fit in a Field (< BLS_ORDER) — same check as Compact's `as Field`
  if (hFull >= BLS_ORDER) return false;

  // Verify challenge reduction: h + quotient * JUBJUB_ORDER == hFull (in Field arithmetic)
  const reconstructed = (sig.challengeH + sig.challengeQuotient * JUBJUB_ORDER) % BLS_ORDER;
  if (reconstructed !== hFull) {
    return false;
  }

  // Verify Schnorr equation: s*G == R + h*pk
  const lhs = ecMulGenerator(sig.s);
  const rhs = ecAdd(sig.R, ecMul(pk, sig.challengeH));
  return lhs.x === rhs.x && lhs.y === rhs.y;
}

/**
 * Derive a Jubjub keypair from a seed.
 *
 * @param seed - Seed bytes (e.g., 32-byte secret)
 * @returns Object with sk (scalar) and pk (JubjubPoint)
 */
export function deriveJubjubKeypair(seed: Uint8Array): { sk: bigint; pk: JubjubPoint } {
  // Hash the seed to derive a scalar
  const skBytes = persistentHash(vec2x32Type, [
    new TextEncoder().encode('jubjub:auth:').reduce((arr, b, i) => { arr[i] = b; return arr; }, new Uint8Array(32)),
    seed,
  ]);
  // Reduce modulo JUBJUB_ORDER, ensure non-zero
  const sk = (bytesToBigint(skBytes) % (JUBJUB_ORDER - 1n)) + 1n;
  const pk = ecMulGenerator(sk);
  return { sk, pk };
}

/**
 * Compute the hash of a JubjubPoint (for storing as mpcPubKeyHash).
 * Matches the circuit's persistentHash<JubjubPoint>(pk).
 */
export function hashJubjubPoint(point: JubjubPoint): Uint8Array {
  return persistentHash(CompactTypeJubjubPoint, point);
}
