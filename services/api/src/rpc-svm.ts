// Devnet's JSON-RPC answered from litesvm's in-process SVM, for tests (E-05). With
// withDevnetStub (rpc-stub.ts), pass-mint.ts's one connection reads accounts from litesvm and its
// sends run there, so a test can follow a pass's history (a stranger's transfer, the mint, a burn)
// through the public helpers without devnet.
import { Transaction, PublicKey } from "@solana/web3.js";
import { FailedTransactionMetadata, type LiteSVM } from "litesvm";

import { encodeBase58 } from "./base58.ts";
import { DEVNET_GENESIS_HASH } from "./pass-mint.ts";
import { accountInfoResult, type RpcAnswer } from "./rpc-stub.ts";

export function svmRpc(svm: LiteSVM): RpcAnswer {
  return (method, params) => {
    switch (method) {
      case "getGenesisHash":
        return DEVNET_GENESIS_HASH;
      case "getAccountInfo": {
        const info = svm.getAccount(new PublicKey(String(params[0])));
        return accountInfoResult(
          info === null
            ? null
            : { owner: info.owner.toBase58(), data: info.data },
          info === null ? undefined : Number(info.lamports),
        );
      }
      case "getMinimumBalanceForRentExemption":
        return Number(
          svm.minimumBalanceForRentExemption(BigInt(Number(params[0]))),
        );
      case "getLatestBlockhash":
        return {
          context: { slot: 1 },
          value: {
            blockhash: svm.latestBlockhash(),
            lastValidBlockHeight: 1_000_000,
          },
        };
      case "sendTransaction": {
        const tx = Transaction.from(Buffer.from(String(params[0]), "base64"));
        const result = svm.sendTransaction(tx);
        if (result instanceof FailedTransactionMetadata)
          throw new Error(
            `transaction failed: ${result.meta().logs().join(" | ")}`,
          );
        svm.expireBlockhash();
        return encodeBase58(tx.signature!);
      }
      case "getSignatureStatuses":
        return {
          context: { slot: 2 },
          value: [
            {
              slot: 2,
              confirmations: 1,
              err: null,
              confirmationStatus: "confirmed",
            },
          ],
        };
      case "getBlockHeight":
        return 1;
      default:
        throw new Error(`unexpected method ${method}`);
    }
  };
}
