import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import type { ChainSignaturesProject } from "../target/types/chain_signatures_project";
import { MockSignerServer } from "../test-utils/MockSignerServer";
import { Connection } from "@solana/web3.js";
import { assert } from "chai";
import { SignatureRespondedSubscriber } from "../test-utils/SignatureRespondedSubscriber";
import { bigintPrivateKeyToNajPublicKey, getEnv } from "../test-utils/utils";
import { chainAdapters, contracts } from "signet.js";

describe("chain-signatures-project", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const connection = new Connection(provider.connection.rpcEndpoint);

  const program = anchor.workspace
    .chainSignaturesProject as Program<ChainSignaturesProject>;

  const env = getEnv();

  const rootPublicKey = bigintPrivateKeyToNajPublicKey(env.PRIVATE_KEY_TESTNET);

  const signetSolContract = new contracts.solana.ChainSignatureContract({
    provider,
    programId: program.programId,
    rootPublicKey,
  });

  const mockServer = new MockSignerServer({ provider, signetSolContract });

  const evmChainAdapter = new chainAdapters.evm.EVM({
    publicClient: {} as any, // Don't care, EVM chain adapter only used to derive address
    contract: signetSolContract,
  });

  const signatureRespondedSubscriber = new SignatureRespondedSubscriber(
    program
  );

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
    await mockServer.start();
  });

  afterEach(async () => {
    await mockServer.stop();
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
