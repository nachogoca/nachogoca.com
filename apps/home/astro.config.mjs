import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://nachogoca.com",
  trailingSlash: "ignore",
  build: { inlineStylesheets: "never" },
  vite: { build: { assetsInlineLimit: 0 } },
});
