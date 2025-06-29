import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import { assert } from "chai";
import { setup } from "../test-utils/setup";

describe("chain-signatures-project", () => {
  const {
    provider,
    program,
    signetSolContract,
    evmChainAdapter,
    signatureRespondedSubscriber,
  } = setup();

  it("Is initialized!", async () => {
    const [programStatePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("program-state")],
      program.programId
    );

    const programState = await program.account.programState.fetch(
      programStatePda
    );

    const expectedDeposit = new BN("100000");
    assert.ok(
      programState.signatureDeposit.eq(expectedDeposit),
      `Expected deposit ${expectedDeposit.toString()}, got ${programState.signatureDeposit.toString()}`
    );

    assert.ok(
      programState.admin.equals(provider.wallet.publicKey),
      "Admin should be set to the wallet public key"
    );
  });

  it("Can request a signature", async () => {
    const signArgs = {
      payload: Array.from({ length: 32 }, (_, i) => i + 1),
      keyVersion: 0,
      path: "",
      algo: "",
      dest: "",
      params: "",
    };

    await program.methods
      .sign(
        signArgs.payload,
        signArgs.keyVersion,
        signArgs.path,
        signArgs.algo,
        signArgs.dest,
        signArgs.params
      )
      .rpc();

    const requestId = signetSolContract.getRequestId(
      {
        payload: signArgs.payload,
        path: signArgs.path,
        key_version: signArgs.keyVersion,
      },
      {
        algo: signArgs.algo,
        dest: signArgs.dest,
        params: signArgs.params,
      }
    );

    const derivedAddress = await evmChainAdapter.deriveAddressAndPublicKey(
      provider.wallet.publicKey.toString(),
      signArgs.path
    );

    const response =
      await signatureRespondedSubscriber.waitForSignatureResponse({
        requestId,
        expectedPayload: Buffer.from(signArgs.payload),
        expectedDerivedAddress: derivedAddress.address,
      });

    assert.ok(response.isValid, "Signature should be valid");
  });
});
