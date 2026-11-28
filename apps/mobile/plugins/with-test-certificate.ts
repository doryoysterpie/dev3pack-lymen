// E-18 (owner's ruling 13a): a test build, for the device check only, that trusts one test
// certificate.
//
// The plugin acts only when LIMEN_TEST_CA_CERT names a PEM certificate file at prebuild. Then
// the generated Android project gets that certificate as res/raw/limen_test_ca.pem and a
// network security config that trusts it for one host, 10.0.2.2, the emulator's address for
// the computer it runs on, where the device check's HTTPS server listens. Any other host keeps
// Android's default trust. With the variable unset, the plugin returns the config unchanged,
// so a release build's generated project is the same as without the plugin.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  withAndroidManifest,
  withDangerousMod,
  type ConfigPlugin,
} from "expo/config-plugins";

/** The one host the test certificate is trusted for. */
export const TEST_HOST = "10.0.2.2";
const RAW_NAME = "limen_test_ca";
const XML_NAME = "limen_network_security_config";

/**
 * Reads the certificate and refuses anything but exactly one PEM certificate, so that a
 * private key can never be copied into the app.
 */
export function readTestCertificate(path: string): string {
  const pem = readFileSync(path, "utf8");
  const blocks = pem.match(/-----BEGIN [A-Z0-9 ]+-----/g) ?? [];
  if (blocks.length !== 1 || blocks[0] !== "-----BEGIN CERTIFICATE-----") {
    throw new Error(
      "LIMEN_TEST_CA_CERT must name a file holding exactly one PEM certificate and nothing else.",
    );
  }
  return pem;
}

/** The network security config the test build gets. */
export function networkSecurityConfig(): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    "<!-- E-18 test build only: trusts the device check's test certificate for one host. -->",
    "<network-security-config>",
    "  <domain-config>",
    `    <domain includeSubdomains="false">${TEST_HOST}</domain>`,
    "    <trust-anchors>",
    `      <certificates src="@raw/${RAW_NAME}" />`,
    "    </trust-anchors>",
    "  </domain-config>",
    "</network-security-config>",
    "",
  ].join("\n");
}

const withTestCertificate: ConfigPlugin = (config) => {
  const certPath = process.env.LIMEN_TEST_CA_CERT;
  if (certPath === undefined || certPath === "") return config;
  const pem = readTestCertificate(resolve(certPath));

  config = withDangerousMod(config, [
    "android",
    async (mod) => {
      const { mkdirSync, writeFileSync } = await import("node:fs");
      const res = resolve(
        mod.modRequest.platformProjectRoot,
        "app/src/main/res",
      );
      mkdirSync(resolve(res, "raw"), { recursive: true });
      mkdirSync(resolve(res, "xml"), { recursive: true });
      writeFileSync(resolve(res, "raw", `${RAW_NAME}.pem`), pem);
      writeFileSync(
        resolve(res, "xml", `${XML_NAME}.xml`),
        networkSecurityConfig(),
      );
      return mod;
    },
  ]);

  return withAndroidManifest(config, (mod) => {
    const application = mod.modResults.manifest.application?.[0];
    if (application === undefined) {
      throw new Error("The Android manifest has no application element.");
    }
    application.$["android:networkSecurityConfig"] = `@xml/${XML_NAME}`;
    return mod;
  });
};

export default withTestCertificate;
