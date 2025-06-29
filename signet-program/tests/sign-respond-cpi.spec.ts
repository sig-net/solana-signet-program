import { assert } from "chai";
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ProxyTestCpi } from "../target/types/proxy_test_cpi";
import { testSetup } from "../test-utils/testSetup";
import { MockCPISignerServer } from "../test-utils/MockCPISignerServer";

interface SignArgs {
  payload: number[];
  keyVersion: number;
  path: string;
  algo: string;
  dest: string;
  params: string;
}

describe("Sign/Respond CPI tests", () => {
  const {
    provider,
    program: signetProgram,
    signetSolContract,
    evmChainAdapter,
    signatureRespondedSubscriber,
  } = testSetup();

  const proxyProgram = anchor.workspace.proxyTestCpi as Program<ProxyTestCpi>;

  const [eventAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    signetProgram.programId
  );

  const mockCPISignerServer = new MockCPISignerServer({
    provider,
    signetSolContract,
    signetProgramId: signetProgram.programId,
  });

  const createSignArgs = (
    pathSuffix: string = "",
    offset: number = 1
  ): SignArgs => ({
    payload: Array.from({ length: 32 }, (_, i) => i + offset),
    keyVersion: 0,
    path: `test-cpi-path${pathSuffix}`,
    algo: "secp256k1",
    dest: "ethereum",
    params: "{}",
  });

  const callProxySign = async (signArgs: SignArgs) => {
    return proxyProgram.methods
      .callSign(
        signArgs.payload,
        signArgs.keyVersion,
        signArgs.path,
        signArgs.algo,
        signArgs.dest,
        signArgs.params
      )
      .accounts({ eventAuthority: eventAuthorityPda })
      .rpc();
  };

  const waitForSignatureResponse = async (signArgs: SignArgs) => {
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

    return signatureRespondedSubscriber.waitForSignatureResponse({
      requestId,
      expectedPayload: Buffer.from(signArgs.payload),
      expectedDerivedAddress: derivedAddress.address,
    });
  };

  before(async () => {
    await mockCPISignerServer.start();
  });

  after(async () => {
    await mockCPISignerServer?.stop();
  });

  it("Can call signet program via CPI and receive signature response", async () => {
    const signArgs = createSignArgs();

    await callProxySign(signArgs);
    const response = await waitForSignatureResponse(signArgs);

    assert.ok(response.isValid, "Signature should be valid");
  });

  it("Can handle multiple concurrent CPI calls", async () => {
    const signRequests = [
      createSignArgs("-1", 10),
      createSignArgs("-2", 20),
      createSignArgs("-3", 30),
    ];

    await Promise.all(signRequests.map(callProxySign));
    const responses = await Promise.all(
      signRequests.map(waitForSignatureResponse)
    );

    responses.forEach((response, index) => {
      assert.ok(response.isValid, `Response ${index + 1} should be valid`);
    });
  });
});
