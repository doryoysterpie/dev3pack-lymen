// Vite config for the station display (E-03). The page calls /api/..., and the dev and preview
// servers forward those requests to the limen API, so the page and the API share one origin.
// STATION_API_URL, from the shell or the repository's root .env, overrides the API address
// (default http://127.0.0.1:8787). It is read here only and never reaches the page.
import { fileURLToPath } from "node:url";

import { defineConfig, loadEnv } from "vite";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

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
    server: { host: "127.0.0.1", port: 5173, strictPort: true, proxy },
    preview: { host: "127.0.0.1", port: 4173, strictPort: true, proxy },
  };
});
