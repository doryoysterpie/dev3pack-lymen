// Vite config for the station display (E-03). The page calls /api/..., and the dev and preview
// servers forward those requests to the limen API, so the page and the API share one origin.
// STATION_API_URL, from the shell or the repository's root .env, overrides the API address
// (default http://127.0.0.1:8787). It is read here, for the proxy.
//
// What the servers may serve:
// - server.fs.allow is this app's folder alone. Vite serves its own client and its dependency
//   cache by its own exemption, and the page loads with nothing else allowed
//   (src/dev-server.test.ts).
// - server.fs.deny adds, to Vite 8.3.8's six default entries, which a deny list replaces, the
//   workspace links in node_modules/@limen (one of them leads to services/api), databases, key
//   folders and keypair files, and .env files, wherever they are.
// - publicDir is false, so no file is copied into the build or served from a public folder.
// - CORS is off on both servers, so another page on localhost cannot read their answers.
// - refuseSecretPaths, a middleware ahead of Vite's own on both servers, answers 403 to any
//   request whose decoded path names one of those kinds of file, because Vite applies fs.deny to
//   /@fs/ paths but not to a file inside the app folder requested by its own path.
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

import { defineConfig, loadEnv, type Plugin } from "vite";

/** The deny list's kinds of file, as patterns on a request's decoded path. */
const SECRET_PATHS = [
  /(^|\/)\.env/,
  /\.(crt|pem|key|p12|pfx|cer|der)$/i,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.yarnrc\.yml$/,
  /(^|\/)\.git(\/|$)/,
  /(^|\/)node_modules\/@limen(\/|$)/,
  /\.db$/i,
  /\.sqlite/i,
  /(^|\/)keys(\/|$)/,
  /keypair[^/]*\.json$/i,
  /(^|\/)id\.json$/,
];

function refuseSecretPaths(): Plugin {
  const guard = (
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void,
  ): void => {
    let path: string;
    try {
      path = decodeURIComponent(
        new URL(req.url ?? "/", "http://station.invalid").pathname,
      );
    } catch {
      res.statusCode = 400;
      res.end();
      return;
    }
    if (SECRET_PATHS.some((pattern) => pattern.test(path))) {
      res.statusCode = 403;
      res.end("Forbidden");
      return;
    }
    next();
  };
  return {
    name: "limen-refuse-secret-paths",
    configureServer(server) {
      server.middlewares.use(guard);
    },
    configurePreviewServer(server) {
      server.middlewares.use(guard);
    },
  };
}

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const appRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repoRoot, "");
  const api =
    process.env.STATION_API_URL ||
    env.STATION_API_URL ||
    "http://127.0.0.1:8787";
  const proxy = {
    "/api": {
      target: api,
      changeOrigin: true,
      rewrite: (path: string) => path.replace(/^\/api/, ""),
    },
  };
  return {
    plugins: [refuseSecretPaths()],
    publicDir: false,
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
      proxy,
      cors: false,
      fs: {
        allow: [appRoot],
        deny: [
          ".env",
          ".env.*",
          "*.{crt,pem,key,p12,pfx,cer,der}",
          ".npmrc",
          ".yarnrc.yml",
          "**/.git/**",
          "**/node_modules/@limen/**",
          "**/*.db",
          "**/*.sqlite*",
          "**/keys/**",
          "**/*keypair*.json",
          "**/id.json",
          "**/.env*",
        ],
      },
    },
    preview: {
      host: "127.0.0.1",
      port: 4173,
      strictPort: true,
      proxy,
      cors: false,
    },
  };
});
