import js from "@eslint/js";
import importPlugin from "eslint-plugin-import";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist",
      ".astro",
      ".wrangler",
      "coverage",
      "playwright-report",
      "test-results",
      "test",
      "eslint.config.js",
      "src/worker-configuration.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ["**/*.ts"],
    plugins: { import: importPlugin },
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "import/no-restricted-paths": [
        "error",
        {
          basePath: ".",
          zones: [
            {
              target: "./src/domains",
              from: "./src/domains",
              except: ["./contracts/**", "./domains/*/index.ts"],
              message: "Domain-to-domain imports must use the other domain's public index.ts.",
            },
          ],
        },
      ],
    },
  },
);
