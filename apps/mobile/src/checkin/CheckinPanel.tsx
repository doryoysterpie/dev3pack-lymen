// The check-in panel shown under a scanned station QR (E-05, app half). It runs the flow in
// flow.ts with the real wallet signer, the device's Ed25519 and the configured API.

import { useState } from "react";
import { Button, StyleSheet, Text, TextInput, View } from "react-native";

import type { CheckinResult } from "./client.ts";
import { CHECKIN_API_URL, STATION_SIGNERS } from "./config.ts";
import { ed25519Verify } from "./ed25519.ts";
import { runCheckin } from "./flow.ts";
import { walletSigner } from "./mwa.ts";

export function CheckinPanel({ qr }: { readonly qr: string }) {
  const [registrationText, setRegistrationText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CheckinResult | null>(null);

  const checkIn = async () => {
    setBusy(true);
    setResult(null);
    try {
      setResult(
        await runCheckin(
          {
            apiBase: CHECKIN_API_URL,
            allowlist: STATION_SIGNERS,
            nowMs: () => Date.now(),
            verify: ed25519Verify,
            signer: walletSigner,
            fetchFn: fetch,
          },
          { qr, registrationText },
        ),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.panel}>
      <Text style={styles.label}>Registration ID (first check-in only)</Text>
      <TextInput
        style={styles.input}
        value={registrationText}
        onChangeText={setRegistrationText}
        autoCapitalize="characters"
        autoCorrect={false}
        placeholder="LMN-0001"
      />
      <Button
        title={busy ? "Checking in" : "Check in"}
        disabled={busy}
        onPress={() => void checkIn()}
      />
      {result === null ? null : result.ok ? (
        <Text style={styles.body}>
          Checked in at station {result.station}, session {result.session}. Your
          pass is {result.mint}.
        </Text>
      ) : (
        <Text style={styles.body}>{result.message}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { gap: 8, marginTop: 12 },
  label: { fontSize: 13, fontWeight: "600" },
  input: { borderWidth: 1, borderRadius: 6, padding: 8, fontSize: 16 },
  body: { fontSize: 16, lineHeight: 22 },
});
