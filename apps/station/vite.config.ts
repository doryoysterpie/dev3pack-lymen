// Vite build for the station page (E-03): one self-contained index.html with its script inlined,
// which the API serves at /station (services/api/src/station-page.ts). No Vite server runs, and
// the build loads no environment (src/build.test.ts).
import { defineConfig, type Plugin } from "vite";

/** Build marker inserted into index.html and required by services/api/src/station-page.ts. */
export const STATION_PAGE_MARKER = "<!-- limen:station-page:v1 -->";

/** Inlines the page's one script into index.html, and fails on any other output. */
export function inlineScript(): Plugin {
  return {
    name: "limen-inline-script",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const names = Object.keys(bundle);
      const html = bundle["index.html"];
      const chunks = Object.values(bundle).filter((o) => o.type === "chunk");
      const chunk = chunks[0];
      if (
        html?.type !== "asset" ||
        chunk === undefined ||
        chunks.length !== 1 ||
        names.length !== 2
      )
        this.error(
          `the station build must emit index.html and one script, not ${names.join(", ")}`,
        );
      const source = String(html.source);
      const tag = `<script type="module" crossorigin src="/${chunk.fileName}"></script>`;
      if (!source.includes(tag))
        this.error(`index.html does not load ${chunk.fileName} as expected`);
      // HTML ends a script element at "</script" in any case, and "<!--" or "<script" inside one
      // changes how the rest parses, so a script holding any of them is refused, not escaped.
      if (/<\/script|<script|<!--/i.test(chunk.code))
        this.error(
          "the station script holds </script, <script or <!--, which would change how index.html parses",
        );
      html.source = source.replace(
        tag,
        () =>
          `${STATION_PAGE_MARKER}<script type="module">${chunk.code}</script>`,
      );
      delete bundle[chunk.fileName];
    },
  };
}

export default defineConfig({
  envDir: false,
  publicDir: false,
  plugins: [inlineScript()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    modulePreload: false,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
  },
});
