// E-18: makes the device check's test certificates with the openssl command-line tool.
//
// Run from the repository root:  node apps/mobile/device-check/make-certificates.mjs
//
// Writes, into apps/mobile/device-check/.certs/ (gitignored):
// - ca.pem: a test CA certificate. The test build trusts this one certificate
//   (LIMEN_TEST_CA_CERT, plugins/with-test-certificate.ts).
// - server.pem and server-key.pem: the HTTPS server's certificate for 10.0.2.2, signed by
//   that CA, and its private key (mode 600).
// The CA's private key is deleted once the server certificate is signed, so no other
// certificate can be issued under the CA the test build trusts. The script prints file paths
// and the CA's SHA-256 fingerprint, never a key. Each run makes a new CA, which needs a new
// test build.

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(fileURLToPath(new URL(".", import.meta.url)), ".certs");
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { mode: 0o700 });
const at = (name) => join(dir, name);

const openssl = (...args) =>
  execFileSync("openssl", args, { stdio: ["ignore", "pipe", "inherit"] });
const newKey = (path) => {
  openssl(
    "genpkey",
    "-algorithm",
    "EC",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-out",
    path,
  );
  chmodSync(path, 0o600);
};

newKey(at("ca-key.pem"));
openssl(
  "req",
  "-x509",
  "-new",
  "-key",
  at("ca-key.pem"),
  "-sha256",
  "-days",
  "7",
  "-subj",
  "/CN=limen device check test CA",
  "-addext",
  "basicConstraints=critical,CA:TRUE,pathlen:0",
  "-addext",
  "keyUsage=critical,keyCertSign,cRLSign",
  "-out",
  at("ca.pem"),
);

newKey(at("server-key.pem"));
openssl(
  "req",
  "-new",
  "-key",
  at("server-key.pem"),
  "-subj",
  "/CN=10.0.2.2",
  "-out",
  at("server.csr"),
);
writeFileSync(
  at("server.ext"),
  [
    "subjectAltName=IP:10.0.2.2",
    "basicConstraints=critical,CA:FALSE",
    "keyUsage=critical,digitalSignature",
    "extendedKeyUsage=serverAuth",
    "",
  ].join("\n"),
);
openssl(
  "x509",
  "-req",
  "-in",
  at("server.csr"),
  "-CA",
  at("ca.pem"),
  "-CAkey",
  at("ca-key.pem"),
  "-set_serial",
  `0x${execFileSync("openssl", ["rand", "-hex", "16"]).toString().trim()}`,
  "-days",
  "7",
  "-sha256",
  "-extfile",
  at("server.ext"),
  "-out",
  at("server.pem"),
);
for (const name of ["ca-key.pem", "server.csr", "server.ext"]) {
  rmSync(at(name));
}

const fingerprint = openssl(
  "x509",
  "-in",
  at("ca.pem"),
  "-noout",
  "-fingerprint",
  "-sha256",
)
  .toString()
  .trim();
console.log(`test CA certificate: ${at("ca.pem")}`);
console.log(`test CA ${fingerprint}`);
console.log(`server certificate for 10.0.2.2: ${at("server.pem")}`);
console.log(`server key (mode 600): ${at("server-key.pem")}`);
console.log("The test CA's private key is deleted.");
