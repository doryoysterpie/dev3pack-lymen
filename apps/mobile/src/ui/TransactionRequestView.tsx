import { useState } from "react";
import {
  ActivityIndicator,
  Button,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  forSigning,
  jsonRpc,
  preflight,
  signingAllowed,
  type Fetch,
  type Preflight,
} from "@limen/preflight";

import { SOLANA_RPC_URL } from "../config.ts";
import type { CardText } from "../pay/card-text.ts";
import { transactionCardText } from "../tx/card-text.ts";
import { requestTransaction } from "../tx/request.ts";
import {
  connectWallet,
  signAndSend,
  type WalletSession,
} from "../wallet/mwa.ts";
import { CardView } from "./CardView.tsx";

type Step =
  | { readonly kind: "start" }
  | { readonly kind: "working"; readonly what: string }
  | {
      readonly kind: "card";
      readonly session: WalletSession;
      readonly result: Preflight;
      readonly message: string | null;
    }
  | { readonly kind: "sent"; readonly signature: string }
  | { readonly kind: "error"; readonly message: string };

const appFetch: Fetch = (url, init) => fetch(url, init);
const rpc = jsonRpc(appFetch, SOLANA_RPC_URL);

function hostOf(link: string): string {
  const match = /^https:\/\/([^/?#]+)/.exec(link);
  return match === null ? link : match[1];
}

const reason = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * The Solana Pay transaction request flow. The sign button exists only on the
 * card step, and it stays disabled until that card has been laid out on
 * screen for the transaction being signed (signingAllowed).
 */
export function TransactionRequestView({
  link,
  intro,
}: {
  readonly link: string;
  readonly intro: CardText;
}) {
  const [step, setStep] = useState<Step>({ kind: "start" });
  const [shownFor, setShownFor] = useState<string | null>(null);
  const host = hostOf(link);

  const fetchAndCheck = async () => {
    try {
      setStep({ kind: "working", what: "Connecting to your wallet" });
      const session = await connectWallet();
      setStep({ kind: "working", what: `Asking ${host} for the transaction` });
      const response = await requestTransaction(
        appFetch,
        link,
        session.address,
      );
      setStep({ kind: "working", what: "Decoding and simulating on devnet" });
      const result = await preflight(
        rpc,
        response.transaction,
        session.address,
      );
      setShownFor(null);
      setStep({ kind: "card", session, result, message: response.message });
    } catch (error) {
      setStep({ kind: "error", message: reason(error) });
    }
  };

  const sign = async (session: WalletSession, result: Preflight) => {
    if (result.kind !== "ready" || !signingAllowed(result, shownFor)) return;
    try {
      setStep({ kind: "working", what: "Waiting for your wallet" });
      const hash = await rpc.latestBlockhash();
      const signature = await signAndSend(session, forSigning(result, hash));
      setStep({ kind: "sent", signature });
    } catch (error) {
      setStep({ kind: "error", message: reason(error) });
    }
  };

  switch (step.kind) {
    case "start":
      return (
        <View style={styles.column}>
          <CardView card={intro} />
          <Text style={styles.note}>
            To ask for the transaction, limen sends your wallet address to{" "}
            {host}.
          </Text>
          <Button
            title="Connect wallet and fetch the transaction"
            onPress={() => void fetchAndCheck()}
          />
        </View>
      );
    case "working":
      return (
        <View style={styles.column}>
          <ActivityIndicator />
          <Text style={styles.note}>{step.what}</Text>
        </View>
      );
    case "card": {
      const { session, result, message } = step;
      const card = transactionCardText(link, message, result, session.address);
      const signable = result.kind === "ready" && result.blocks.length === 0;
      return (
        <View style={styles.column}>
          <View
            onLayout={() =>
              setShownFor(result.kind === "ready" ? result.base64 : null)
            }
          >
            <CardView card={card} />
          </View>
          {signable ? (
            <Button
              title="Sign with your wallet"
              disabled={!signingAllowed(result, shownFor)}
              onPress={() => void sign(session, result)}
            />
          ) : null}
        </View>
      );
    }
    case "sent":
      return (
        <View style={styles.column}>
          <Text style={styles.title}>Sent to devnet</Text>
          <Text style={styles.note} selectable>
            Signature: {step.signature}
          </Text>
        </View>
      );
    case "error":
      return (
        <View style={styles.column}>
          <Text style={styles.title}>Stopped</Text>
          <Text style={styles.note}>{step.message}</Text>
          <Button
            title="Start again"
            onPress={() => setStep({ kind: "start" })}
          />
        </View>
      );
  }
}

const styles = StyleSheet.create({
  column: { gap: 12 },
  title: { fontSize: 22, fontWeight: "600" },
  note: { fontSize: 15, lineHeight: 21 },
});
