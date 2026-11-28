import { useState } from "react";
import {
  ActivityIndicator,
  Button,
  Switch,
  StyleSheet,
  Text,
  View,
} from "react-native";

import * as SecureStore from "expo-secure-store";

import appJson from "../../app.json";
import { buildReport, type ReadyPreflight } from "./bundle.ts";
import { sendReport, type ReportFetch } from "./client.ts";
import { API_URL } from "./config.ts";
import { installId } from "./device-id.ts";

// The Decline and Report actions under a transaction request card (E-10, app side). Decline
// comes first; the report is offered only after it.

type Phase =
  | { readonly kind: "offer" }
  | { readonly kind: "declined" }
  | { readonly kind: "sending" }
  | {
      readonly kind: "sent";
      readonly caseId: number;
      readonly caseStatus: string;
    }
  | { readonly kind: "failed"; readonly reason: string };

const appFetch: ReportFetch = (url, init) => fetch(url, init);

const STATUS_TEXT: Readonly<Record<string, string>> = {
  held: "held for a human",
  escalated: "escalated",
  dismissed: "dismissed",
};

export function ReportPanel({
  qrText,
  link,
  result,
  user,
  onDecline,
}: {
  readonly qrText: string;
  readonly link: string;
  readonly result: ReadyPreflight;
  readonly user: string;
  readonly onDecline: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "offer" });
  const [includeWallet, setIncludeWallet] = useState(false);

  const report = async () => {
    if (API_URL === null) return;
    setPhase({ kind: "sending" });
    const bundle = buildReport({
      preflight: result,
      qrText,
      link,
      user,
      includeWallet,
      deviceId: await installId(SecureStore),
      timestamp: Math.floor(Date.now() / 1000),
      appVersion: appJson.expo.version,
    });
    const outcome = await sendReport(appFetch, API_URL, bundle);
    setPhase(
      outcome.ok
        ? {
            kind: "sent",
            caseId: outcome.caseId,
            caseStatus: outcome.caseStatus,
          }
        : { kind: "failed", reason: outcome.reason },
    );
  };

  switch (phase.kind) {
    case "offer":
      return (
        <Button
          title="Decline"
          onPress={() => {
            onDecline();
            setPhase({ kind: "declined" });
          }}
        />
      );
    case "declined":
      if (API_URL === null) {
        return (
          <Text style={styles.note}>
            You declined this transaction. This build has no report server set
            (EXPO_PUBLIC_API_URL), so it cannot send a report.
          </Text>
        );
      }
      return (
        <View style={styles.column}>
          <Text style={styles.note}>
            You declined this transaction. You can report this QR to the limen
            triage team. The report sends the QR text, its link, the transaction
            and what this card showed.
          </Text>
          <View style={styles.row}>
            <Switch value={includeWallet} onValueChange={setIncludeWallet} />
            <Text style={styles.label}>Include my wallet address</Text>
          </View>
          <Text style={styles.note}>
            Off unless you turn it on. The transaction itself still names your
            wallet as its signer.
          </Text>
          <Button title="Report this QR" onPress={() => void report()} />
        </View>
      );
    case "sending":
      return (
        <View style={styles.column}>
          <ActivityIndicator />
          <Text style={styles.note}>Sending the report</Text>
        </View>
      );
    case "sent":
      return (
        <Text style={styles.note}>
          Reported as case {phase.caseId}:{" "}
          {STATUS_TEXT[phase.caseStatus] ?? phase.caseStatus}.
        </Text>
      );
    case "failed":
      return (
        <View style={styles.column}>
          <Text style={styles.note}>{phase.reason}</Text>
          <Button title="Try again" onPress={() => void report()} />
        </View>
      );
  }
}

const styles = StyleSheet.create({
  column: { gap: 12 },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  label: { fontSize: 15, fontWeight: "600" },
  note: { fontSize: 15, lineHeight: 21 },
});
