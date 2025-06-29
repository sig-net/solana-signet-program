import { assert } from "chai";
import { testSetup } from "../test-utils/testSetup";
import { MockCPISignerServer } from "../test-utils/MockCPISignerServer";

describe("Sign/Respond wallet transaction tests", () => {
  const {
    provider,
    program,
    signetSolContract,
    evmChainAdapter,
    signatureRespondedSubscriber,
  } = testSetup();

  const mockServer = new MockCPISignerServer({
    provider,
    signetSolContract,
    signetProgramId: program.programId,
  });

  before(async () => {
    await mockServer.start();
  });

  after(async () => {
    await mockServer.stop();
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
