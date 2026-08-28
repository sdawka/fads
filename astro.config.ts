import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import svelte from "@astrojs/svelte";
import { conceptIsolationPolicy, isConceptPath } from "./src/concept-isolation";

export default defineConfig({
  output: "server",
  adapter: cloudflare(),
  integrations: [svelte()],
  vite: {
    plugins: [
      {
        name: "fads:concept-isolation-dev-header",
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (isConceptPath(new URL(request.url ?? "/", "http://localhost").pathname)) {
              response.setHeader("content-security-policy", conceptIsolationPolicy);
            }
            next();
          });
        },
      },
    ],
  },
});
