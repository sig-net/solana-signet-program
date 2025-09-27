import { assert } from 'chai';
import { testSetup } from '../test-utils/testSetup';
import {
  createSignArgs,
  callDirectSign,
  waitForSignatureResponse,
} from '../test-utils/signingUtils';

describe('Sign/Respond wallet tests', () => {
  const { program, signetSolContract } = testSetup();

  it('Can request a signature', async () => {
    const signArgs = createSignArgs('WALLET_TEST', 'wallet');

    const txSignature = await callDirectSign(program, signArgs);
    const response = await waitForSignatureResponse(
      signArgs,
      signetSolContract,
      txSignature
    );

    assert.ok(response.isValid, 'Signature should be valid');
  });
});
