import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("module import boundaries", () => {
  it("allows contracts, same-module internals, and public cross-module indexes only", () => {
    expect(() => {
      execFileSync(process.execPath, ["scripts/verify-domain-boundaries.mjs"], {
        cwd: process.cwd(),
        stdio: "pipe",
      });
    }).not.toThrow();
  });
});
