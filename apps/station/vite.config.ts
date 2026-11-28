// Vite build for the station page (E-03): one self-contained index.html with its script inlined,
// which the API serves at /station (services/api/src/station-page.ts). No Vite server runs, and
// the build loads no environment (src/build.test.ts).
import { defineConfig, type Plugin } from "vite";

/** Inlines the page's one script into index.html, and fails on any other output. */
function inlineScript(): Plugin {
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
      // "</script" inside the code would end the element early.
      const code = chunk.code.replaceAll("</script", "<\\/script");
      html.source = source.replace(
        tag,
        () => `<script type="module">${code}</script>`,
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
