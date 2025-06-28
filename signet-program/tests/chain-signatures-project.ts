import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { ChainSignaturesProject } from "../target/types/chain_signatures_project";
import { MockSignerServer } from "../test-utils/MockSignerServer";
import { Connection } from "@solana/web3.js";
import { assert } from "chai";
import { SignatureRespondedSubscriber } from "../test-utils/SignatureRespondedSubscriber";
import { getEVMChainAdapter, getSolanaProgram } from "../test-utils/utils";
import { chainAdapters } from "signet.js";

describe("chain-signatures-project", () => {
  anchor.setProvider(anchor.AnchorProvider.env());

  const connection = new Connection(
    anchor.getProvider().connection.rpcEndpoint
  );

  const program = anchor.workspace
    .chainSignaturesProject as Program<ChainSignaturesProject>;

  before(async () => {
    const tx = await program.methods.initialize(new BN("100000")).rpc();

    const latestBlockhash = await connection.getLatestBlockhash();

    await connection.confirmTransaction(
      {
        signature: tx,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      },
      "confirmed"
    );
  });

  beforeEach(async () => {
    // Initialize the mock server to response requests locally
    const server = new MockSignerServer();
    await server.start();
  });

  afterEach(async () => {
    const server = new MockSignerServer();
    await server.stop();
  });

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

    const provider = anchor.getProvider();
    assert.ok(
      programState.admin.equals(provider.wallet.publicKey),
      "Admin should be set to the wallet public key"
    );
  });

  it("Can request a signature", async () => {
    const subscriber = new SignatureRespondedSubscriber(program, connection);

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

    const requestId = getSolanaProgram().getRequestId(
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

    const derivedAddress = await getEVMChainAdapter().deriveAddressAndPublicKey(
      anchor.getProvider().wallet.publicKey.toString(),
      signArgs.path
    );

    const response = await subscriber.waitForSignatureResponse(
      requestId,
      Buffer.from(signArgs.payload),
      derivedAddress.address
    );

    assert.ok(response.isValid, "Signature should be valid");
  });
});
