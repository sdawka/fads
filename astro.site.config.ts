import { defineConfig } from "astro/config";
import svelte from "@astrojs/svelte";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  site: "https://fads.cc",
  srcDir: "./site",
  publicDir: "./site/public",
  outDir: "./dist-site",
  cacheDir: "./.astro-site",
  output: "static",
  integrations: [svelte()],
  vite: { plugins: [tailwindcss()] },
});
