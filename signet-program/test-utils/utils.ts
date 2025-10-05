import * as anchor from '@coral-xyz/anchor';

export const confirmTransaction = async (
  connection: anchor.web3.Connection,
  signature: string
) => {
  const latestBlockhash = await connection.getLatestBlockhash();

  await connection.confirmTransaction(
    {
      signature,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    },
    'confirmed'
  );
};
