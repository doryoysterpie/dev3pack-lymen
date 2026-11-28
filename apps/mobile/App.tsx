import {
  CameraView,
  useCameraPermissions,
  type BarcodeScanningResult,
} from "expo-camera";
import { StatusBar } from "expo-status-bar";
import { useState } from "react";
import { Button, ScrollView, StyleSheet, Text, View } from "react-native";

import type { CardText } from "./src/pay/card-text.ts";
import { loadRecipientLists } from "./src/pay/recipient-lists.ts";
import recipientListsJson from "./src/pay/recipient-lists.json";
import { resultCard } from "./src/result-card.ts";
import { CardView } from "./src/ui/CardView.tsx";

// Devnet fixture lists, loaded once; a list entry that is not a public key
// fails here, at start-up. "organizers" in src/pay/recipient-lists.json holds
// the devnet organizer public key; a new organizer key replaces that entry.
const RECIPIENT_LISTS = loadRecipientLists(recipientListsJson);

interface Scan {
  readonly text: string;
  readonly card: CardText;
}

export default function App() {
  const [permission, requestPermission] = useCameraPermissions();
  const [scan, setScan] = useState<Scan | null>(null);

  // The scanner can report the same QR several times before the screen
  // changes. Only the first report is kept.
  const onBarcodeScanned = ({ data }: BarcodeScanningResult) => {
    setScan(
      (current) =>
        current ?? { text: data, card: resultCard(data, RECIPIENT_LISTS) },
    );
  };

  if (permission === null) {
    return <View style={styles.centre} />;
  }

  if (!permission.granted) {
    return (
      <View style={styles.centre}>
        <Text style={styles.body}>
          limen needs the camera to read QR codes.
        </Text>
        {permission.canAskAgain ? (
          <Button
            title="Allow camera"
            onPress={() => void requestPermission()}
          />
        ) : (
          <Text style={styles.body}>
            Camera access is off. Turn it on in the system settings.
          </Text>
        )}
      </View>
    );
  }

  if (scan !== null) {
    return (
      <ScrollView contentContainerStyle={styles.card}>
        <CardView card={scan.card} />
        <Text style={styles.label}>Scanned text</Text>
        <Text style={styles.raw} selectable>
          {scan.text}
        </Text>
        <Button title="Scan another QR" onPress={() => setScan(null)} />
        <StatusBar style="dark" />
      </ScrollView>
    );
  }

  return (
    <View style={styles.fill}>
      <CameraView
        style={styles.fill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={onBarcodeScanned}
      />
      <StatusBar style="light" />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  centre: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    padding: 24,
  },
  card: { gap: 12, padding: 24, paddingTop: 64 },
  body: { fontSize: 16, lineHeight: 22 },
  label: { fontSize: 13, fontWeight: "600", marginTop: 12 },
  raw: { fontFamily: "monospace", fontSize: 13 },
});
