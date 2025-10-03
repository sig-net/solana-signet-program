import { ethers } from 'ethers';

export class RequestIdGenerator {
  static generateSignRespondRequestId(
    sender: string,
    transactionData: number[],
    caip2Id: string,
    keyVersion: number,
    path: string,
    algo: string,
    dest: string,
    params: string
  ): string {
    const txDataHex = '0x' + Buffer.from(transactionData).toString('hex');
    const encoded = ethers.solidityPacked(
      [
        'string',
        'bytes',
        'string',
        'uint32',
        'string',
        'string',
        'string',
        'string',
      ],
      [sender, txDataHex, caip2Id, keyVersion, path, algo, dest, params]
    );
    return ethers.keccak256(encoded);
  }

  static generateRequestId(
    addr: string,
    payload: number[],
    path: string,
    keyVersion: number,
    chainId: number | string,
    algo: string,
    dest: string,
    params: string
  ): string {
    const payloadHex = '0x' + Buffer.from(payload).toString('hex');
    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
      [
        'string',
        'bytes',
        'string',
        'uint32',
        'uint256',
        'string',
        'string',
        'string',
      ],
      [addr, payloadHex, path, keyVersion, chainId, algo, dest, params]
    );
    return ethers.keccak256(encoded);
  }
}
