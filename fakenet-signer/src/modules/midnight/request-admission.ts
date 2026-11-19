import {
  type AnySignBidirectionalEvent,
  bytesToHex,
  isTronSignBidirectionalEvent,
  MIDNIGHT_RESPOND_BIDIRECTIONAL_PATH,
  MPCDestination,
  MPCSignatureAlgorithm,
  TRON_CAIP2_ID,
} from '@sig-net/midnight';

export const LATEST_MPC_KEY_VERSION = 1n;

const RESPONSE_KEY_PATH = (() => {
  const path = new Uint8Array(32);
  path.set(new TextEncoder().encode(MIDNIGHT_RESPOND_BIDIRECTIONAL_PATH));
  return path;
})();

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.length === right.length &&
    left.every((byte, index) => byte === right[index])
  );
}

function renderPaddedAscii(bytes: Uint8Array, field: string): string {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  const trimmed = bytes.subarray(0, end);
  if (trimmed.includes(0)) {
    throw new Error(`${field} has an interior NUL: ${bytesToHex(bytes)}`);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(trimmed);
  } catch {
    throw new Error(`${field} is not valid UTF-8: ${bytesToHex(bytes)}`);
  }
}

export function midnightRequestRejection(
  record: AnySignBidirectionalEvent,
  readAddress: string
): string | undefined {
  const sender = bytesToHex(record.sender.bytes);
  const read = readAddress.replace(/^0x/i, '').toLowerCase();
  if (sender !== read) {
    return `record sender ${sender} does not match the address it was read from ${read}`;
  }
  if (record.keyVersion < 1n) {
    return 'key_version 0 predates bidirectional signing: at least 1 is required';
  }
  if (record.algo !== MPCSignatureAlgorithm.ecdsa) {
    return `unsupported algo ${record.algo}`;
  }
  if (record.signatureDest !== MPCDestination.unused) {
    return `unsupported signature_dest ${record.signatureDest}`;
  }
  if (bytesEqual(record.path, RESPONSE_KEY_PATH)) {
    return 'path is reserved for the MPC response key';
  }
  let caip2Id: string;
  try {
    caip2Id = renderPaddedAscii(record.executionDest, 'execution_dest');
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (record.params.some((byte) => byte !== 0)) {
    return `params is reserved and must be blank, got ${bytesToHex(record.params)}`;
  }
  if (record.keyVersion > LATEST_MPC_KEY_VERSION) {
    return `unsupported key_version ${record.keyVersion}: the latest is ${LATEST_MPC_KEY_VERSION}`;
  }
  const isTron = isTronSignBidirectionalEvent(record);
  if (isTron !== (caip2Id === TRON_CAIP2_ID)) {
    return `execution_dest ${caip2Id} does not name ${isTron ? 'Tron' : 'Ethereum'}, the chain family the record's tx_params assemble for`;
  }
  return undefined;
}
