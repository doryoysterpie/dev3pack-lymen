// The check-in panel shown under a scanned station QR (E-05, app half). It runs the flow in
// flow.ts with the real wallet signer, the device's Ed25519 and the configured API, in two steps:
// "Check in" connects the wallet and shows the exact five-line message (which holds no
// registration ID; the ID travels only in the POST body), and only the separate "Sign this
// message" button, shown with that message, has the wallet sign it.

import { useState } from "react";
import { Button, StyleSheet, Text, TextInput, View } from "react-native";

import type { CheckinResult } from "./client.ts";
import { CHECKIN_API_URL, STATION_SIGNERS } from "./config.ts";
import { ed25519Verify } from "./ed25519.ts";
import {
  prepareCheckin,
  type CheckinFlowDeps,
  type PreparedCheckin,
} from "./flow.ts";
import { walletSigner } from "./mwa.ts";

type ReadyCheckin = Extract<PreparedCheckin, { ok: true }>;

const deps: CheckinFlowDeps = {
  apiBase: CHECKIN_API_URL,
  allowlist: STATION_SIGNERS,
  nowMs: () => Date.now(),
  verify: ed25519Verify,
  signer: walletSigner,
  fetchFn: fetch,
};

export function CheckinPanel({ qr }: { readonly qr: string }) {
  const [registrationText, setRegistrationText] = useState("");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState<ReadyCheckin | null>(null);
  const [result, setResult] = useState<CheckinResult | null>(null);

  const checkIn = async () => {
    setBusy(true);
    setResult(null);
    setReady(null);
    try {
      const prepared = await prepareCheckin(deps, { qr, registrationText });
      if (prepared.ok) setReady(prepared);
      else setResult(prepared);
    } finally {
      setBusy(false);
    }
  };

  const signShown = async (shown: ReadyCheckin) => {
    setBusy(true);
    try {
      setResult(await shown.sign());
      setReady(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.panel}>
      {ready === null ? (
        <>
          <Text style={styles.label}>
            Registration ID (first check-in only)
          </Text>
          <TextInput
            style={styles.input}
            value={registrationText}
            onChangeText={setRegistrationText}
            autoCapitalize="characters"
            autoCorrect={false}
            placeholder="LMN-0001"
          />
          <Button
            title={busy ? "Connecting" : "Check in"}
            disabled={busy}
            onPress={() => void checkIn()}
          />
        </>
      ) : (
        <>
          <Text style={styles.label}>
            Your wallet will be asked to sign exactly this message:
          </Text>
          <View style={styles.message}>
            {ready.preview.lines.map((line, i) => (
              <Text key={i} style={styles.mono} selectable>
                {line}
              </Text>
            ))}
          </View>
          <Button
            title={busy ? "Signing" : "Sign this message"}
            disabled={busy}
            onPress={() => void signShown(ready)}
          />
          <Button
            title="Cancel"
            disabled={busy}
            onPress={() => setReady(null)}
          />
        </>
      )}
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
  message: { borderWidth: 1, borderRadius: 6, padding: 8, gap: 2 },
  mono: { fontFamily: "monospace", fontSize: 13 },
  body: { fontSize: 16, lineHeight: 22 },
});
