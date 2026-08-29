import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ESLint } from "eslint";
import { domainBoundaryRule } from "../eslint.config.js";

const fixtureRoot = path.resolve("test/fixtures/domain-boundaries");
const validFixture = path.join(fixtureRoot, "src/modules/edition/valid-imports.ts");
const invalidFixtures = [
  path.join(fixtureRoot, "src/modules/edition/deep-cross-module-import.ts"),
  path.join(fixtureRoot, "src/modules/edition/deep-cross-module-export-named.ts"),
  path.join(fixtureRoot, "src/modules/edition/deep-cross-module-export-all.ts"),
];

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
const invalidResults = await Promise.all(
  invalidFixtures.map(async (fixture) => {
    const [result] = await eslint.lintText(await readFile(fixture, "utf8"), { filePath: fixture });
    return result;
  }),
);

assert.equal(
  validResult.errorCount,
  0,
  "public indexes, contracts, and same-module imports must pass",
);
for (const invalidResult of invalidResults) {
  assert.equal(invalidResult.errorCount, 1, "deep cross-module imports and re-exports must fail");
  assert.equal(invalidResult.messages[0]?.ruleId, "fads/domain-boundaries");
}
