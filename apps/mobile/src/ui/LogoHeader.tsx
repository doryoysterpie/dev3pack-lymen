import { Image, StyleSheet, View } from "react-native";

// The limen logo (E-19), rendered from assets/limen-logo.svg at the repository root as
// logo.png, logo@2x.png and logo@3x.png; React Native picks the file for the screen's density.
// The wordmark reads as limen or lymen, so its alt text gives the name, "limen".
import LOGO from "../../assets/logo.png";

/** The app header on the scan and card screens: the logo on a white bar below the status bar. */
export function LogoHeader() {
  return (
    <View style={styles.header}>
      <Image source={LOGO} alt="limen" style={styles.logo} />
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    backgroundColor: "#ffffff",
    paddingTop: 48,
    paddingBottom: 12,
    paddingHorizontal: 24,
  },
  logo: { width: 93, height: 32 },
});
