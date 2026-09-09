import { describe, expect, it } from "vitest";
import { checkReadiness } from "../../src/readiness";

describe("installation readiness", () => {
  it("checks both database schema and durable session storage", async () => {
    const checked: string[] = [];
    await expect(
      checkReadiness({
        validateConfig: () => {
          checked.push("config");
        },
        checkDatabase: async () => {
          checked.push("database");
        },
        checkSessions: async () => {
          checked.push("sessions");
        },
      }),
    ).resolves.toBe(true);
    expect(checked).toEqual(["config", "database", "sessions"]);
  });
  it("fails closed when configuration, migrations or a binding is unavailable", async () => {
    for (const failure of ["config", "database", "sessions"]) {
      const check = (name: string) => {
        if (name === failure) throw new Error("private details");
      };
      await expect(
        checkReadiness({
          validateConfig: () => check("config"),
          checkDatabase: async () => check("database"),
          checkSessions: async () => check("sessions"),
        }),
      ).resolves.toBe(false);
    }
  });
});
