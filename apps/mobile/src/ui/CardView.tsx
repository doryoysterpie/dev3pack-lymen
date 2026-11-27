import { StyleSheet, Text, View } from "react-native";

import type { CardText, Tone } from "../pay/card-text.ts";

const TONE_COLOUR: Readonly<Record<Tone, string>> = {
  organizer: "#1b5e20",
  flagged: "#b71c1c",
  malformed: "#b71c1c",
  neutral: "#37474f",
};

export function CardView({ card }: { readonly card: CardText }) {
  return (
    <View style={styles.card}>
      <Text style={styles.title}>{card.title}</Text>
      <Text style={[styles.status, { color: TONE_COLOUR[card.tone] }]}>
        {card.status}
      </Text>
      {card.rows.map((row) => (
        <View key={row.label} style={styles.row}>
          <Text style={styles.label}>{row.label}</Text>
          <Text
            style={row.quoted === true ? styles.quoted : styles.value}
            selectable
          >
            {row.value}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { gap: 12 },
  title: { fontSize: 22, fontWeight: "600" },
  status: { fontSize: 16, fontWeight: "600", lineHeight: 22 },
  row: { gap: 2 },
  label: { fontSize: 13, fontWeight: "600" },
  value: { fontSize: 15, lineHeight: 21 },
  // Text from the QR or the requester: boxed, monospaced and grey, so it does
  // not read like limen's status line.
  quoted: {
    fontSize: 14,
    lineHeight: 20,
    fontFamily: "monospace",
    color: "#455a64",
    backgroundColor: "#eceff1",
    borderLeftWidth: 3,
    borderLeftColor: "#90a4ae",
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
});
