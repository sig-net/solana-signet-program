import { CONFIG } from '../../config/Config';

export interface TronReceipt {
  id: string;
  blockNumber: bigint;
  result?: string;
  receiptResult?: string;
  resMessage?: string;
}

export interface SolidifiedBlock {
  number: bigint;
  timestamp: bigint;
  refSlice: Uint8Array;
  txids: string[];
}

export interface TronReader {
  getTransactionInfoSolidity(txid: string): Promise<TronReceipt | null>;
  getNowBlockSolidity(): Promise<SolidifiedBlock>;
  getBlockSolidity(number: bigint): Promise<SolidifiedBlock | null>;
}

export interface TronClientConfig {
  endpoint: string;
  apiKey?: string;
  requestTimeoutMs?: number;
}

interface BlockJson {
  blockID?: string;
  block_header?: { raw_data?: { number?: number; timestamp?: number } };
  transactions?: { txID?: string }[];
}

interface TransactionInfoJson {
  id?: string;
  blockNumber?: number;
  result?: string;
  resMessage?: string;
  receipt?: { result?: string };
}

function decodeHexAscii(value: string): string {
  if (!/^([0-9a-fA-F]{2})*$/.test(value)) return value;
  const text = Buffer.from(value, 'hex').toString('utf8');
  return /^[\x20-\x7e\s]*$/.test(text) ? text : value;
}

export function parseSolidifiedBlock(body: BlockJson): SolidifiedBlock | null {
  const raw = body.block_header?.raw_data;
  if (raw === undefined) return null;
  const blockId = body.blockID ?? '';
  const refSlice = /^[0-9a-fA-F]{64}$/.test(blockId)
    ? Uint8Array.from(Buffer.from(blockId, 'hex').subarray(8, 16))
    : new Uint8Array(8);
  return {
    number: BigInt(raw.number ?? 0),
    timestamp: BigInt(raw.timestamp ?? 0),
    refSlice,
    txids: (body.transactions ?? [])
      .map((tx) => tx.txID?.toLowerCase())
      .filter(
        (id): id is string => id !== undefined && /^[0-9a-f]{64}$/.test(id)
      ),
  };
}

export function parseTransactionInfo(
  body: TransactionInfoJson
): TronReceipt | null {
  if (body.id === undefined) return null;
  return {
    id: body.id.toLowerCase(),
    blockNumber: BigInt(body.blockNumber ?? 0),
    result: body.result,
    receiptResult: body.receipt?.result,
    resMessage:
      body.resMessage === undefined
        ? undefined
        : decodeHexAscii(body.resMessage),
  };
}

export class TronClient implements TronReader {
  private readonly endpoint: string;
  private readonly apiKey?: string;
  private readonly requestTimeoutMs: number;

  constructor(config: TronClientConfig) {
    this.endpoint = config.endpoint.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.requestTimeoutMs = config.requestTimeoutMs ?? CONFIG.RPC_TIMEOUT_MS;
  }

  async getTransactionInfoSolidity(txid: string): Promise<TronReceipt | null> {
    return parseTransactionInfo(
      await this.postJson<TransactionInfoJson>(
        'walletsolidity/gettransactioninfobyid',
        { value: txid.replace(/^0x/, '').toLowerCase(), visible: false }
      )
    );
  }

  async getNowBlockSolidity(): Promise<SolidifiedBlock> {
    const block = parseSolidifiedBlock(
      await this.postJson<BlockJson>('walletsolidity/getnowblock', {})
    );
    if (block === null) throw new Error('Tron: solidified head absent');
    return block;
  }

  async getBlockSolidity(number: bigint): Promise<SolidifiedBlock | null> {
    return parseSolidifiedBlock(
      await this.postJson<BlockJson>('walletsolidity/getblockbynum', {
        num: Number(number),
      })
    );
  }

  private async postJson<T>(path: string, body: object): Promise<T> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (this.apiKey) headers['TRON-PRO-API-KEY'] = this.apiKey;
    const response = await fetch(`${this.endpoint}/${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Tron http ${path}: ${response.status}: ${text}`);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Tron http ${path}: undecodable response: ${text}`);
    }
  }
}
