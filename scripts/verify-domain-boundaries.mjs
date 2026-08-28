import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ESLint } from "eslint";
import { domainBoundaryRule } from "../eslint.config.js";

const fixtureRoot = path.resolve("test/fixtures/domain-boundaries");
const validFixture = path.join(fixtureRoot, "src/modules/edition/valid-imports.ts");
const invalidFixture = path.join(fixtureRoot, "src/modules/edition/deep-cross-module-import.ts");

const eslint = new ESLint({
  overrideConfigFile: true,
  overrideConfig: [
    {
      files: ["**/*.ts"],
      plugins: { fads: { rules: { "domain-boundaries": domainBoundaryRule } } },
      rules: { "fads/domain-boundaries": "error" },
    },
  ],
});

const [validResult] = await eslint.lintText(await readFile(validFixture, "utf8"), {
  filePath: validFixture,
});
const [invalidResult] = await eslint.lintText(await readFile(invalidFixture, "utf8"), {
  filePath: invalidFixture,
});

assert.equal(
  validResult.errorCount,
  0,
  "public indexes, contracts, and same-module imports must pass",
);
assert.equal(invalidResult.errorCount, 1, "deep cross-module imports must fail");
assert.equal(invalidResult.messages[0]?.ruleId, "fads/domain-boundaries");
