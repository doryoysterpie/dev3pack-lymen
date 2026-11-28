// Vite config for the station display (E-03). The dev and preview servers forward /api to the
// limen API at STATION_API_URL, or http://127.0.0.1:8787. What they serve (src/dev-server.test.ts):
// - dev: in apps/station, index.html, the .ts and .css files under src, and Vite's dependency
//   cache; any other file there gets 403 (onlySourceFiles);
// - preview: / and the files Vite's manifest names (manifestFiles);
// - both: 403 by name, outside /api, for keys, keypair files, databases, .env files and the
//   node_modules/@limen links (refuseSecretPaths), and no CORS header;
// - build: no public folder, and a failure when the output holds a file the manifest does not
//   name (checkBuildOutput).
import type { IncomingMessage, ServerResponse } from "node:http";
import { readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
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
      // The files Vite's manifest names when the preview starts; the manifest itself is not served.
      const served =
        manifestFiles(
          resolve(server.config.root, server.config.build.outDir),
        ) ?? new Set<string>();
      server.middlewares.use((req, res, next) => {
        const path = new URL(req.url ?? "/", "http://station.invalid").pathname;
        if (
          path === "/" ||
          path === "/api" ||
          path.startsWith("/api/") ||
          served.has(path.slice(1))
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

const MANIFEST = ".vite/manifest.json";

/**
 * The files Vite's manifest (build.manifest) names in `outDir`: each .html entry, and each
 * entry's file, CSS and assets, as paths relative to `outDir`. Null when there is no manifest.
 */
function manifestFiles(outDir: string): Set<string> | null {
  let manifest: Record<
    string,
    { file: string; css?: string[]; assets?: string[] }
  >;
  try {
    manifest = JSON.parse(readFileSync(join(outDir, MANIFEST), "utf8"));
  } catch {
    return null;
  }
  const files = new Set<string>();
  for (const [key, entry] of Object.entries(manifest)) {
    if (key.endsWith(".html")) files.add(key);
    files.add(entry.file);
    for (const file of [...(entry.css ?? []), ...(entry.assets ?? [])])
      files.add(file);
  }
  return files;
}

/** Every file under `dir`, as paths relative to it with "/" between parts. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? filesUnder(join(dir, entry.name)).map((f) => `${entry.name}/${f}`)
      : [entry.name],
  );
}

/** Fails the build when its output folder holds a file Vite's manifest does not name. */
function checkBuildOutput(): Plugin {
  return {
    name: "limen-check-build-output",
    apply: "build",
    writeBundle(options) {
      const dir = options.dir;
      if (dir === undefined) return;
      const named = manifestFiles(dir);
      if (named === null)
        throw new Error("the station build wrote no Vite manifest");
      const others = filesUnder(dir).filter(
        (file) => file !== MANIFEST && !named.has(file),
      );
      if (others.length > 0)
        throw new Error(
          `the station build output holds files not named in Vite's manifest: ${others.join(", ")}`,
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
    build: { manifest: true },
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
