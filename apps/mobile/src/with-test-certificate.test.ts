// E-18 (owner's ruling 13a): the release build's config carries no test-certificate trust,
// and the test build trusts one PEM certificate for 10.0.2.2 alone.

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { getConfig, type ExpoConfig } from "expo/config";
import {
  compileModsAsync,
  withPlugins,
  type ExportedConfig,
  type StaticPlugin,
} from "expo/config-plugins";

import {
  networkSecurityConfig,
  TEST_HOST,
} from "../plugins/with-test-certificate.ts";

const mobileRoot = fileURLToPath(new URL("..", import.meta.url));
const pluginPath = "./plugins/with-test-certificate.ts";

const baseManifest = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<manifest xmlns:android="http://schemas.android.com/apk/res/android">',
  '  <application android:name=".MainApplication" />',
  "</manifest>",
  "",
].join("\n");

// Not a real certificate: PEM framing around fixed ASCII text so the plugin's
// exact-copy and single-block checks run with no key material in the repository.
const sampleCert = [
  "-----BEGIN CERTIFICATE-----",
  "bGltZW4tZTE4LXRlc3QtY2VydGlmaWNhdGUtZml4dHVyZQ==",
  "-----END CERTIFICATE-----",
  "",
].join("\n");

async function withEnv<T>(
  certPath: string | undefined,
  fn: () => Promise<T> | T,
): Promise<T> {
  const had = Object.prototype.hasOwnProperty.call(
    process.env,
    "LIMEN_TEST_CA_CERT",
  );
  const previous = process.env.LIMEN_TEST_CA_CERT;
  if (certPath === undefined) {
    delete process.env.LIMEN_TEST_CA_CERT;
  } else {
    process.env.LIMEN_TEST_CA_CERT = certPath;
  }
  try {
    return await fn();
  } finally {
    if (had) {
      process.env.LIMEN_TEST_CA_CERT = previous;
    } else {
      delete process.env.LIMEN_TEST_CA_CERT;
    }
  }
}

function pluginEntries(
  plugins: ExpoConfig["plugins"],
): (string | StaticPlugin<unknown>)[] {
  return (plugins ?? []).map((entry) => {
    if (typeof entry === "string") return entry;
    if (entry.length === 1) return [entry[0], undefined];
    if (entry.length === 2) return [entry[0], entry[1]];
    throw new Error("Unexpected empty plugin entry in app.json.");
  });
}

async function compileAndroidConfig(config: ExportedConfig) {
  const projectRoot = mkdtempSync(join(tmpdir(), "limen-e18-test-"));
  try {
    const androidDir = join(projectRoot, "android");
    const mainDir = join(androidDir, "app/src/main");
    mkdirSync(mainDir, { recursive: true });
    writeFileSync(join(androidDir, "gradle.properties"), "");
    writeFileSync(join(mainDir, "AndroidManifest.xml"), baseManifest);

    await compileModsAsync(config, {
      projectRoot,
      platforms: ["android"],
      assertMissingModProviders: false,
    });

    const rawPath = join(mainDir, "res/raw/limen_test_ca.pem");
    const xmlPath = join(mainDir, "res/xml/limen_network_security_config.xml");
    return {
      manifest: readFileSync(join(mainDir, "AndroidManifest.xml"), "utf8"),
      gradleProperties: readFileSync(
        join(androidDir, "gradle.properties"),
        "utf8",
      ),
      rawCert: existsSync(rawPath) ? readFileSync(rawPath, "utf8") : null,
      securityXml: existsSync(xmlPath) ? readFileSync(xmlPath, "utf8") : null,
    };
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

async function compileFromAppJson(certPath: string | undefined) {
  return withEnv(certPath, async () => {
    const { exp }: { exp: ExportedConfig } = getConfig(mobileRoot, {
      isModdedConfig: true,
    });
    return compileAndroidConfig(exp);
  });
}

describe("E-18: with-test-certificate config plugin (ruling 13a)", () => {
  it("keeps app.json's icon, adaptive icon, Android package and plugin order", async () => {
    await withEnv(undefined, () => {
      const { exp } = getConfig(mobileRoot);
      assert.equal(exp.icon, "./assets/icon.png");
      assert.deepEqual(exp.android?.adaptiveIcon, {
        foregroundImage: "./assets/icon.png",
        backgroundColor: "#FFFFFF",
      });
      assert.equal(exp.android?.package, "app.antelimen.limen");
      assert.equal(exp.plugins?.at(-1), pluginPath);
    });
  });

  it("leaves the release build config and Android project without test-certificate trust", async () => {
    const appJson = JSON.parse(
      readFileSync(join(mobileRoot, "app.json"), "utf8"),
    ) as { expo: ExpoConfig };
    const rawPluginsWithoutTestCert = (appJson.expo.plugins ?? []).filter(
      (entry) => entry !== pluginPath,
    );
    assert.equal(
      rawPluginsWithoutTestCert.length,
      (appJson.expo.plugins ?? []).length - 1,
    );

    const { exp: skeleton } = getConfig(mobileRoot, { skipPlugins: true });
    const baseCompiled = await compileAndroidConfig(
      withPlugins(
        { ...structuredClone(skeleton), plugins: rawPluginsWithoutTestCert },
        pluginEntries(rawPluginsWithoutTestCert),
      ),
    );

    for (const unsetValue of [undefined, ""] as const) {
      await withEnv(unsetValue, () => {
        const { exp }: { exp: ExportedConfig } = getConfig(mobileRoot, {
          isModdedConfig: true,
        });
        assert.equal(exp.mods?.android?.dangerous, undefined);
      });

      const releaseCompiled = await compileFromAppJson(unsetValue);
      assert.deepEqual(releaseCompiled, baseCompiled);
      assert.ok(!releaseCompiled.manifest.includes("networkSecurityConfig"));
      assert.equal(releaseCompiled.rawCert, null);
      assert.equal(releaseCompiled.securityXml, null);
    }
  });

  it("adds test-certificate trust for 10.0.2.2 alone when LIMEN_TEST_CA_CERT names one PEM certificate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "limen-e18-cert-"));
    try {
      const certFile = join(dir, "ca.pem");
      writeFileSync(certFile, sampleCert);

      const compiled = await compileFromAppJson(certFile);
      assert.match(
        compiled.manifest,
        /android:networkSecurityConfig="@xml\/limen_network_security_config"/,
      );
      assert.equal(compiled.rawCert, sampleCert);
      assert.equal(compiled.securityXml, networkSecurityConfig());
      assert.match(
        compiled.securityXml ?? "",
        new RegExp(
          `<domain includeSubdomains="false">${TEST_HOST.replaceAll(".", "\\.")}</domain>`,
        ),
      );
      assert.ok(!(compiled.securityXml ?? "").includes("<base-config"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses non-certificate or multi-block PEM files without echoing their contents", async () => {
    const dir = mkdtempSync(join(tmpdir(), "limen-e18-bad-"));
    try {
      const marker = "sensitive-body-marker-do-not-print";
      const keyHeader = ["BEGIN", "EC PARAMETERS"].join(" ");
      const keyFooter = ["END", "EC PARAMETERS"].join(" ");
      const badInputs = [
        `-----${keyHeader}-----\n${marker}\n-----${keyFooter}-----\n`,
        `${sampleCert}${sampleCert}`,
        `${sampleCert}-----${keyHeader}-----\n${marker}\n-----${keyFooter}-----\n`,
        `not pem at all: ${marker}\n`,
      ];

      for (const [index, contents] of badInputs.entries()) {
        const path = join(dir, `bad-${index}.pem`);
        writeFileSync(path, contents);
        await withEnv(path, () => {
          assert.throws(
            () => getConfig(mobileRoot, { isModdedConfig: true }),
            (error: unknown) => {
              assert.ok(error instanceof Error);
              assert.equal(
                error.message,
                "LIMEN_TEST_CA_CERT must name a file holding exactly one PEM certificate and nothing else.",
              );
              assert.ok(!error.message.includes(marker));
              return true;
            },
          );
        });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
