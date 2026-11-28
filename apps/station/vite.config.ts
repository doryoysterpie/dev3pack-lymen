// Vite config for the station display (E-03). The page calls /api/..., and the dev and preview
// servers forward those requests to the limen API, so the page and the API share one origin.
// STATION_API_URL, from the shell or the repository's root .env, overrides the API address
// (default http://127.0.0.1:8787). It is read here, for the proxy.
//
// What the servers may serve:
// - server.fs.allow is this app's src folder and index.html, and nothing else in apps/station.
//   Vite serves its own client and its dependency cache, where the page's one dependency,
//   qrcode, is bundled, by its own exemption; no node_modules path is allowed
//   (src/dev-server.test.ts).
// - server.fs.deny adds, to Vite 8.3.8's six default entries, which a deny list replaces, the
//   workspace links in node_modules/@limen (one of them leads to services/api), databases, key
//   folders and keypair files, and .env files, wherever they are.
// - publicDir is false, so no file is copied into the build or served from a public folder.
// - CORS is off on both servers, so another page on localhost cannot read their answers.
// - refuseSecretPaths, a middleware ahead of Vite's own on both servers, answers 403 to any
//   request whose decoded path names one of those kinds of file. It leaves /api requests, which
//   the proxy forwards, alone, so a station named "keys" still reaches the API.
// - The preview server answers / and paths ending .html, .js, .css or .svg, and 403 to any
//   other path outside /api, so it serves the built page and nothing else.
// - checkBuildOutput fails the build when the output folder holds anything but the page's
//   .html, .js, .css and .svg files.
import type { IncomingMessage, ServerResponse } from "node:http";
import { readdirSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
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
    if (path === "/api" || path.startsWith("/api/")) {
      next();
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
      server.middlewares.use(onlySourceFiles);
    },
    configurePreviewServer(server) {
      server.middlewares.use(guard);
      server.middlewares.use((req, res, next) => {
        const path = new URL(req.url ?? "/", "http://station.invalid").pathname;
        if (
          path === "/" ||
          path === "/api" ||
          path.startsWith("/api/") ||
          PAGE_FILE.test(path)
        ) {
          next();
          return;
        }
        res.statusCode = 403;
        res.end("Forbidden");
      });
    },
  };
}

/**
 * In the station folder, the dev server answers for the page's source files alone: index.html,
 * .ts and .css files under src, and Vite's dependency cache. A request that names any other file
 * there, by its path or by /@fs/, gets 403. Vite's own paths (/@vite/, /@id/) pass through.
 */
function onlySourceFiles(
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
): void {
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
  if (path === "/api" || path.startsWith("/api/")) return next();
  if (path.startsWith("/@") && !path.startsWith("/@fs/")) return next();
  const file = path.startsWith("/@fs/")
    ? path.slice("/@fs".length)
    : join(appRoot, path);
  const rel = relative(appRoot, file);
  const inStation = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  if (
    !inStation ||
    rel === "" ||
    rel === "index.html" ||
    /^src\/.+\.(ts|css)$/.test(rel) ||
    /^node_modules\/\.vite\/deps\/[^/]+\.js$/.test(rel)
  )
    return next();
  res.statusCode = 403;
  res.end("Forbidden");
}

/** The kinds of file the built page is made of. */
const PAGE_FILE = /\.(html|js|css|svg)$/;

/** Every file under `dir`, as paths relative to it. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? filesUnder(join(dir, entry.name)).map((f) => join(entry.name, f))
      : [entry.name],
  );
}

function checkBuildOutput(): Plugin {
  return {
    name: "limen-check-build-output",
    apply: "build",
    writeBundle(options) {
      const dir = options.dir;
      if (dir === undefined) return;
      const others = filesUnder(dir).filter((file) => !PAGE_FILE.test(file));
      if (others.length > 0)
        throw new Error(
          `the station build output holds files that are not the page's html, js, css or svg: ${others.join(", ")}`,
        );
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
    plugins: [refuseSecretPaths(), checkBuildOutput()],
    publicDir: false,
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
      proxy,
      cors: false,
      fs: {
        allow: [join(appRoot, "src"), join(appRoot, "index.html")],
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
          "**/*.json",
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
