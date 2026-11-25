import {
  respondOutputWidth,
  unsupportedEvmOutputFields,
} from '@sig-net/midnight';

/**
 * Why the MPC refuses to sign a Midnight request over its output schema, or
 * `undefined` when it signs. The MPC refuses every request whose execution
 * it could attest for no return data at all: a schema it cannot read, an ABI
 * type outside the subset it attests (`unsupportedEvmOutputFields`), and a
 * plain transfer whose schema declares return values.
 */
export function outputSchemaRejection(
  outputDeserializationSchema: Uint8Array,
  isContractCall: boolean
): string | undefined {
  let unsupported: ReturnType<typeof unsupportedEvmOutputFields>;
  try {
    unsupported = unsupportedEvmOutputFields(outputDeserializationSchema);
  } catch (error) {
    return `malformed output schema (${error instanceof Error ? error.message : String(error)})`;
  }
  if (unsupported.length > 0) {
    return (
      `unsupported output type${unsupported.length > 1 ? 's' : ''} ` +
      unsupported.map((field) => `'${field.name}' (${field.type})`).join(', ')
    );
  }
  if (!isContractCall && respondOutputWidth(outputDeserializationSchema) > 0) {
    return 'a plain transfer returns nothing, but the output schema declares return values';
  }
  return undefined;
}
