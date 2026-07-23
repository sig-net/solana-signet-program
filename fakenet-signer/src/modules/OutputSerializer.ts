import * as borsh from 'borsh';
import type { Schema } from 'borsh';
import { ethers } from 'ethers';
import {
  TransactionOutputData,
  BorshSchema,
  AbiSchemaField,
  MidnightSchemaField,
  SerializableValue,
} from '../types';
import { SerializationFormat } from './ChainUtils';

export class OutputSerializer {
  static async serialize(
    output: TransactionOutputData,
    format: SerializationFormat,
    schema: Buffer | number[]
  ): Promise<Uint8Array> {
    this.validateSchema(schema);

    switch (format) {
      case SerializationFormat.Borsh:
        return this.serializeBorsh(output, schema);
      case SerializationFormat.ABI:
        return this.serializeAbi(output, schema);
      case SerializationFormat.Midnight:
        return this.serializeMidnight(output, schema);
      default:
        throw new Error(`Unsupported serialization format: ${format}`);
    }
  }

  private static validateSchema(schema: Buffer | number[]): void {
    const schemaStr = this.getSchemaString(schema).trim();
    if (!schemaStr) {
      throw new Error(
        'Empty serialization schema — cannot serialize without a valid schema'
      );
    }
    try {
      JSON.parse(schemaStr);
    } catch {
      throw new Error(
        `Invalid serialization schema — not valid JSON: ${schemaStr.slice(0, 100)}`
      );
    }
  }

  private static async serializeBorsh(
    output: TransactionOutputData,
    schema: Buffer | number[]
  ): Promise<Uint8Array> {
    const schemaStr = this.getSchemaString(schema);
    const parsedSchema = JSON.parse(schemaStr);

    // Handle scalar bool schema (schema is literally "bool")
    if (typeof parsedSchema === 'string' && parsedSchema === 'bool') {
      const outputRecord = output as Record<string, unknown>;
      const boolValue =
        typeof output === 'boolean'
          ? output
          : 'error' in outputRecord
            ? Boolean(outputRecord.error)
            : 'success' in outputRecord
              ? Boolean(outputRecord.success)
              : true;

      try {
        return borsh.serialize('bool' as unknown as Schema, boolValue);
      } catch (error) {
        console.error(
          '[OutputSerializer] Borsh serialization failed (scalar bool)',
          { schema: parsedSchema, payload: boolValue },
          error
        );
        throw error;
      }
    }

    const borshSchema = parsedSchema as BorshSchema;

    let dataToSerialize: SerializableValue = output;
    if (output.isFunctionCall === false) {
      dataToSerialize = this.createBorshData(borshSchema, output);
    }

    // Handle single-field objects with empty key
    if (typeof dataToSerialize === 'object' && dataToSerialize !== null) {
      const keys = Object.keys(dataToSerialize as TransactionOutputData);
      if (keys.length === 1 && keys[0] === '') {
        dataToSerialize =
          (dataToSerialize as TransactionOutputData)[''] ?? dataToSerialize;
      }
    }

    // Wrap common boolean error struct when payload is an object with `error`
    if (
      borshSchema.struct &&
      Object.keys(borshSchema.struct).length === 1 &&
      borshSchema.struct.error === 'bool' &&
      typeof dataToSerialize === 'object' &&
      dataToSerialize !== null &&
      'error' in (dataToSerialize as Record<string, unknown>)
    ) {
      const data = dataToSerialize as Record<string, unknown>;
      dataToSerialize = { error: Boolean(data.error) };
    }

    try {
      return borsh.serialize(borshSchema as Schema, dataToSerialize);
    } catch (error) {
      // Emit schema/payload for debugging serialization issues
      console.error(
        '[OutputSerializer] Borsh serialization failed',
        {
          schema: borshSchema,
          payload: dataToSerialize,
        },
        error
      );
      throw error;
    }
  }

  private static async serializeAbi(
    output: TransactionOutputData,
    schema: Buffer | number[]
  ): Promise<Uint8Array> {
    const schemaStr = this.getSchemaString(schema);
    const parsedSchema = JSON.parse(schemaStr) as AbiSchemaField[];

    let dataToEncode: TransactionOutputData = output;
    if (output.isFunctionCall === false) {
      dataToEncode = this.createAbiData(parsedSchema);
    }

    const values = parsedSchema.map((field) => {
      if (dataToEncode[field.name] === undefined) {
        throw new Error(`Missing required field '${field.name}' in output`);
      }
      return dataToEncode[field.name];
    });

    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
      parsedSchema.map((s) => s.type),
      values
    );

    return ethers.getBytes(encoded);
  }

  /**
   * Midnight serialization for Compact contracts.
   *
   * Layout rules (each value LE, matching Compact's `slice<N>(data, offset) as Field`):
   *   Fixed types (bool, uint*, int*, address, bytes1-32): 32 bytes LE
   *   string/bytes: 32-byte LE length + payload zero-padded to maxBytes
   *   Dynamic arrays (type[]): 32-byte LE count + each element 32 bytes LE, padded to maxItems
   *
   * Fields are concatenated in schema order. The contract reads at compile-time-known offsets.
   */
  private static async serializeMidnight(
    output: TransactionOutputData,
    schema: Buffer | number[]
  ): Promise<Uint8Array> {
    const schemaStr = this.getSchemaString(schema);
    const parsedSchema = JSON.parse(schemaStr) as MidnightSchemaField[];

    let dataToEncode: TransactionOutputData = output;
    if (output.isFunctionCall === false) {
      dataToEncode = this.createMidnightDefaults(parsedSchema, output);
    }

    const totalSize = this.midnightTotalSize(parsedSchema);
    const result = new Uint8Array(totalSize);
    let offset = 0;

    for (const field of parsedSchema) {
      const value = dataToEncode[field.name];
      const { bytes, size } = this.midnightEncodeField(value, field);
      result.set(bytes, offset);
      offset += size;
    }

    return result;
  }

  private static midnightFieldSize(field: MidnightSchemaField): number {
    const { type } = field;
    if (type === 'string' || type === 'bytes') {
      if (!field.maxBytes)
        throw new Error(
          `Midnight schema: '${field.name}' (${type}) requires maxBytes`
        );
      return 32 + field.maxBytes;
    }
    if (type.endsWith('[]')) {
      if (!field.maxItems)
        throw new Error(
          `Midnight schema: '${field.name}' (${type}) requires maxItems`
        );
      return 32 + field.maxItems * 32;
    }
    return 32;
  }

  private static midnightTotalSize(schema: MidnightSchemaField[]): number {
    return schema.reduce((sum, f) => sum + this.midnightFieldSize(f), 0);
  }

  private static midnightEncodeField(
    value: unknown,
    field: MidnightSchemaField
  ): { bytes: Uint8Array; size: number } {
    const { type } = field;
    const size = this.midnightFieldSize(field);

    if (type.endsWith('[]')) {
      const arr = value as unknown[];
      const bytes = new Uint8Array(size);
      const maxItems = (size - 32) / 32; // size = 32 + maxItems * 32 (midnightFieldSize)
      bytes.set(this.bigintToBytes32LE(BigInt(arr.length)), 0);
      for (let i = 0; i < Math.min(arr.length, maxItems); i++) {
        const elemValue =
          typeof arr[i] === 'bigint'
            ? (arr[i] as bigint)
            : BigInt(arr[i] as number);
        bytes.set(this.bigintToBytes32LE(elemValue), 32 + i * 32);
      }
      return { bytes, size };
    }

    if (type === 'bool') {
      return { bytes: this.bigintToBytes32LE(value ? 1n : 0n), size };
    }

    if (type.startsWith('uint') || type.startsWith('int')) {
      const n = typeof value === 'bigint' ? value : BigInt(value as number);
      return { bytes: this.bigintToBytes32LE(n), size };
    }

    if (type === 'address') {
      const addr = typeof value === 'string' ? value : String(value);
      const addrBigint = BigInt(addr);
      return { bytes: this.bigintToBytes32LE(addrBigint), size };
    }

    if (type.match(/^bytes\d+$/)) {
      const raw =
        value instanceof Uint8Array ? value : ethers.getBytes(value as string);
      const word = new Uint8Array(32);
      word.set(raw.slice(0, 32));
      return { bytes: word, size };
    }

    if (type === 'string') {
      const str = typeof value === 'string' ? value : String(value);
      const payload = new TextEncoder().encode(str);
      const bytes = new Uint8Array(size);
      const lenBytes = this.bigintToBytes32LE(BigInt(payload.length));
      bytes.set(lenBytes, 0);
      bytes.set(payload.slice(0, size - 32), 32); // size = 32 + maxBytes
      return { bytes, size };
    }

    if (type === 'bytes') {
      const raw =
        value instanceof Uint8Array ? value : ethers.getBytes(value as string);
      const bytes = new Uint8Array(size);
      const lenBytes = this.bigintToBytes32LE(BigInt(raw.length));
      bytes.set(lenBytes, 0);
      bytes.set(raw.slice(0, size - 32), 32); // size = 32 + maxBytes
      return { bytes, size };
    }

    throw new Error(`Unsupported Midnight type: ${type}`);
  }

  private static bigintToBytes32LE(n: bigint): Uint8Array {
    const bytes = new Uint8Array(32);
    let val = n < 0n ? -n : n;
    for (let i = 0; i < 32 && val > 0n; i++) {
      bytes[i] = Number(val & 0xffn);
      val >>= 8n;
    }
    return bytes;
  }

  private static createMidnightDefaults(
    schema: MidnightSchemaField[],
    fallback?: TransactionOutputData
  ): TransactionOutputData {
    const data: TransactionOutputData = {};
    for (const field of schema) {
      const fallbackValue = fallback?.[field.name];
      if (fallbackValue !== undefined) {
        data[field.name] = fallbackValue;
        continue;
      }
      if (field.type === 'bool') data[field.name] = true;
      else if (field.type === 'string') data[field.name] = '';
      else if (field.type === 'bytes') data[field.name] = '0x';
      else if (field.type.endsWith('[]')) data[field.name] = [];
      else data[field.name] = 0n;
    }
    return data;
  }

  private static getSchemaString(schema: Buffer | number[]): string {
    if (typeof schema === 'string') return schema;
    // On-chain schemas are fixed-size, NUL-padded byte arrays. Cut at the first
    // NUL before parsing — trailing \0 bytes are not whitespace, so `.trim()`
    // leaves them in place and JSON.parse rejects them.
    const raw = new TextDecoder().decode(new Uint8Array(schema));
    const nul = raw.indexOf('\0');
    return nul === -1 ? raw : raw.slice(0, nul);
  }

  private static createBorshData(
    borshSchema: BorshSchema,
    fallback?: TransactionOutputData
  ): TransactionOutputData {
    const struct = borshSchema.struct;
    if (!struct) {
      return { success: true };
    }

    const obj: TransactionOutputData = {};
    for (const [key, type] of Object.entries(struct)) {
      if (fallback && key in fallback && fallback[key] !== undefined) {
        obj[key] = fallback[key];
        continue;
      }

      // Only bool and string defaults exist, matching
      // default_output_for_non_contract_call in
      // github.com/sig-net/mpc/chain-signatures/chain-ethereum/src/respond_bidirectional.rs:261
      // which bails on every other type.
      switch (type) {
        case 'bool':
          obj[key] = true;
          break;
        case 'string':
          obj[key] = 'non_function_call_success';
          break;
        default:
          throw new Error(
            `Cannot serialize non-function call success as type ${type}`
          );
      }
    }
    return obj;
  }

  private static createAbiData(
    schema: AbiSchemaField[]
  ): TransactionOutputData {
    const data: TransactionOutputData = {};
    schema.forEach((field) => {
      if (field.type === 'string') {
        data[field.name] = 'non_function_call_success';
      } else if (field.type === 'bool') {
        data[field.name] = true;
      } else {
        throw new Error(
          `Cannot serialize non-function call success as type ${field.type}`
        );
      }
    });
    return data;
  }
}
