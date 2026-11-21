import { readFileSync } from "node:fs";
import { defineConfig } from "astro/config";

// Guard: a manifest produced by `publish-photos --target local` points at /_local-img,
// which only exists on your machine. Refuse to deploy it.
const manifest = JSON.parse(readFileSync(new URL("./src/data/manifest.json", import.meta.url), "utf8"));
if ((process.env.CF_PAGES || process.env.CI) && !manifest.imageBase.startsWith("https://")) {
  throw new Error(
    `manifest.json imageBase is "${manifest.imageBase}" (local preview). Re-run \`npm run publish-photos\` with --target r2 and commit that.`,
  );
}

export default defineConfig({
  site: "https://photo.nachogoca.com",
  trailingSlash: "ignore",
  build: { inlineStylesheets: "never" },
  vite: { build: { assetsInlineLimit: 0 } },
});
