import { assert } from "chai";
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ChainSignaturesProject } from "../target/types/chain_signatures_project";
import { ProxyTestCpi } from "../target/types/proxy_test_cpi";
import { setup } from "../test-utils/setup";
import { MockCPISignerServer } from "../test-utils/MockCPISignerServer";

describe.only("proxy-cpi-test", () => {
  const {
    provider,
    program: signetProgram,
    signetSolContract,
    evmChainAdapter,
    signatureRespondedSubscriber,
  } = setup();

  let proxyProgram: Program<ProxyTestCpi>;
  let mockCPISignerServer: MockCPISignerServer;

  before(async () => {
    proxyProgram = anchor.workspace.proxyTestCpi as Program<ProxyTestCpi>;

    mockCPISignerServer = new MockCPISignerServer({
      provider,
      signetSolContract,
      signetProgramId: signetProgram.programId,
    });

    await mockCPISignerServer.start();
  });

  after(async () => {
    if (mockCPISignerServer) {
      await mockCPISignerServer.stop();
    }
  });

  it("Can call signet program via CPI and receive signature response", async () => {
    const signArgs = {
      payload: Array.from({ length: 32 }, (_, i) => i + 1),
      keyVersion: 0,
      path: "test-cpi-path",
      algo: "secp256k1",
      dest: "ethereum",
      params: "{}",
    };

    const [eventAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("__event_authority")],
      signetProgram.programId
    );

    await proxyProgram.methods
      .callSign(
        signArgs.payload,
        signArgs.keyVersion,
        signArgs.path,
        signArgs.algo,
        signArgs.dest,
        signArgs.params
      )
      .accounts({
        eventAuthority: eventAuthorityPda,
      })
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

  it("Can handle multiple concurrent CPI calls", async () => {
    const signRequests = [
      {
        payload: Array.from({ length: 32 }, (_, i) => i + 10),
        keyVersion: 0,
        path: "test-cpi-path-1",
        algo: "secp256k1",
        dest: "ethereum",
        params: "{}",
      },
      {
        payload: Array.from({ length: 32 }, (_, i) => i + 20),
        keyVersion: 0,
        path: "test-cpi-path-2",
        algo: "secp256k1",
        dest: "ethereum",
        params: "{}",
      },
      {
        payload: Array.from({ length: 32 }, (_, i) => i + 30),
        keyVersion: 0,
        path: "test-cpi-path-3",
        algo: "secp256k1",
        dest: "ethereum",
        params: "{}",
      },
    ];

    const [eventAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("__event_authority")],
      signetProgram.programId
    );

    const txPromises = signRequests.map((signArgs) =>
      proxyProgram.methods
        .callSign(
          signArgs.payload,
          signArgs.keyVersion,
          signArgs.path,
          signArgs.algo,
          signArgs.dest,
          signArgs.params
        )
        .accounts({
          eventAuthority: eventAuthorityPda,
        })
        .rpc()
    );

    const txSignatures = await Promise.all(txPromises);

    const responsePromises = signRequests.map(async (signArgs) => {
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
    });

    const responses = await Promise.all(responsePromises);

    responses.forEach((response, index) => {
      assert.ok(response.isValid, `Response ${index + 1} should be valid`);
    });
  });
});
