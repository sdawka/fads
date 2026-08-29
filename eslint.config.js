import js from "@eslint/js";
import path from "node:path";
import tseslint from "typescript-eslint";

function isWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function moduleId(segments) {
  if (segments[0] === "sources") {
    return segments[1] ? `sources/${segments[1]}` : undefined;
  }

  return segments[0];
}

function moduleRootLength(segments) {
  return segments[0] === "sources" ? 2 : 1;
}

export const domainBoundaryRule = {
  meta: {
    type: "problem",
    docs: { description: "restrict cross-module imports to each module's public index" },
    schema: [],
    messages: {
      deepCrossDomain:
        "Cross-module imports must use the other module's public index.ts, not {{importPath}}.",
    },
  },
  create(context) {
    const filename = path.resolve(context.filename);
    const marker = `${path.sep}src${path.sep}modules${path.sep}`;
    const markerIndex = filename.lastIndexOf(marker);

    if (markerIndex === -1) return {};

    const projectRoot = filename.slice(0, markerIndex);
    const modulesRoot = path.join(projectRoot, "src", "modules");
    const contractsRoot = path.join(projectRoot, "src", "contracts");

    const currentSegments = path.relative(modulesRoot, filename).split(path.sep);
    const currentModule = moduleId(currentSegments);

    function checkPath(node, importPath) {
      if (!importPath.startsWith(".")) return;

      const resolved = path.resolve(path.dirname(filename), importPath);
      if (isWithin(resolved, contractsRoot) || !isWithin(resolved, modulesRoot)) return;

      const target = path.relative(modulesRoot, resolved).split(path.sep);
      const targetModule = moduleId(target);
      const isSameModule = targetModule !== undefined && targetModule === currentModule;
      const publicPath = target.slice(moduleRootLength(target));
      const isPublicIndex =
        targetModule !== undefined &&
        (publicPath.length === 0 || (publicPath.length === 1 && publicPath[0] === "index"));

      if (!isSameModule && !isPublicIndex) {
        context.report({ node, messageId: "deepCrossDomain", data: { importPath } });
      }
    }

    function checkSource(node) {
      if (node.source) checkPath(node, node.source.value);
    }

    return {
      ImportDeclaration: checkSource,
      ExportNamedDeclaration: checkSource,
      ExportAllDeclaration: checkSource,
    };
  },
};

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
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ["**/*.ts"],
  })),
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
  {
    files: ["src/modules/**/*.ts"],
    plugins: { fads: { rules: { "domain-boundaries": domainBoundaryRule } } },
    rules: {
      "fads/domain-boundaries": "error",
    },
  },
);
