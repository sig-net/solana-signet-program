import * as borsh from 'borsh';
import { ethers } from 'ethers';

export class OutputSerializer {
  static async serialize(
    output: Record<string, unknown>,
    format: number,
    schema: Buffer | number[]
  ): Promise<Uint8Array> {
    if (format === 0) {
      return this.serializeBorsh(output, schema);
    } else if (format === 1) {
      return this.serializeAbi(output, schema);
    }

    throw new Error(`Unsupported serialization format: ${format}`);
  }

  private static async serializeBorsh(
    output: Record<string, unknown>,
    schema: Buffer | number[]
  ): Promise<Uint8Array> {
    const schemaStr = this.getSchemaString(schema);
    const borshSchema = JSON.parse(schemaStr) as Record<string, unknown>;

    let dataToSerialize: Record<string, unknown> | unknown = output;
    if (output.isFunctionCall === false) {
      dataToSerialize = this.createBorshData(borshSchema);
    }

    // Handle single-field objects with empty key
    if (typeof dataToSerialize === 'object' && dataToSerialize !== null) {
      const keys = Object.keys(dataToSerialize as Record<string, unknown>);
      if (keys.length === 1 && keys[0] === '') {
        dataToSerialize = (dataToSerialize as Record<string, unknown>)[''];
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const serialized = borsh.serialize(borshSchema as any, dataToSerialize);
    return serialized;
  }

  private static async serializeAbi(
    output: Record<string, unknown>,
    schema: Buffer | number[]
  ): Promise<Uint8Array> {
    const schemaStr = this.getSchemaString(schema);
    const parsedSchema = JSON.parse(schemaStr) as Array<{
      name: string;
      type: string;
    }>;

    let dataToEncode: Record<string, unknown> = output;
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

  private static getSchemaString(schema: Buffer | number[]): string {
    return typeof schema === 'string'
      ? schema
      : new TextDecoder().decode(new Uint8Array(schema));
  }

  private static createBorshData(
    borshSchema: Record<string, unknown>
  ): Record<string, unknown> {
    const struct = borshSchema.struct as Record<string, string> | undefined;
    if (struct && struct.message === 'string') {
      return { message: 'non_function_call_success' };
    } else if (struct && struct.success === 'bool') {
      return { success: true };
    }
    return { success: true };
  }

  private static createAbiData(
    schema: Array<{ name: string; type: string }>
  ): Record<string, unknown> {
    const data: Record<string, unknown> = {};
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
