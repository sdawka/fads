import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");
const generateKey = join(root, "scripts/generate-oauth-key.mjs");
const checkInstall = join(root, "scripts/check-install.mjs");

async function temporaryDirectory() {
  return mkdtemp(join(tmpdir(), "fads-install-test-"));
}

async function runScript(script: string, cwd: string, args: string[] = []) {
  try {
    const result = await run(process.execPath, [script, ...args], { cwd });
    return { code: 0, ...result };
  } catch (error) {
    const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

const validInstallConfig = `{
  "name": "reader-owner",
  "d1_databases": [{ "binding": "DB", "database_id": "bc22303d-b8c0-45a0-9090-5b47557ebcac", "migrations_dir": "migrations" }],
  "queues": {
    "producers": [{ "binding": "INGESTION_QUEUE", "queue": "reader-ingestion" }],
    "consumers": [{ "queue": "reader-ingestion", "dead_letter_queue": "reader-ingestion-dlq" }]
  },
  "durable_objects": { "bindings": [{ "name": "OWNER_SESSION", "class_name": "OwnerSessionDO" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["OwnerSessionDO"] }],
  "triggers": { "crons": ["*/15 * * * *"] },
  "vars": { "OWNER_DID": "did:plc:owner123", "APP_ORIGIN": "https://reader.example" }
}`;

describe("self-hosted install scripts", () => {
  it("creates one private ES256 JWK file without exposing its private material", async () => {
    const cwd = await temporaryDirectory();
    const output = join(cwd, ".fads-install/oauth.jwks.json");
    try {
      const result = await runScript(generateKey, cwd);
      const keys = JSON.parse(await readFile(output, "utf8"));

      expect(result).toMatchObject({ code: 0 });
      expect(result.stdout).not.toContain('"d"');
      expect(keys).toHaveLength(1);
      expect(keys[0]).toMatchObject({ kty: "EC", crv: "P-256", alg: "ES256" });
      expect(typeof keys[0].kid).toBe("string");
      expect(typeof keys[0].d).toBe("string");
      expect((await stat(output)).mode & 0o777).toBe(0o600);
      expect((await stat(join(cwd, ".fads-install"))).mode & 0o777).toBe(0o700);

      const retry = await runScript(generateKey, cwd);
      expect(retry.code).not.toBe(0);
      expect(retry.stderr).toContain("already exists");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("accepts a complete local install configuration and generated key", async () => {
    const cwd = await temporaryDirectory();
    try {
      await writeFile(join(cwd, "wrangler.install.jsonc"), validInstallConfig);
      expect((await runScript(generateKey, cwd)).code).toBe(0);

      const result = await runScript(checkInstall, cwd);
      expect(result).toMatchObject({ code: 0, stderr: "" });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects placeholder resources and configuration values by name only", async () => {
    const cwd = await temporaryDirectory();
    try {
      await mkdir(join(cwd, ".fads-install"));
      await writeFile(
        join(cwd, "wrangler.install.jsonc"),
        validInstallConfig
          .replace("bc22303d-b8c0-45a0-9090-5b47557ebcac", "00000000-0000-0000-0000-000000000000")
          .replace("reader-ingestion-dlq", "YOUR_DLQ_NAME")
          .replace("did:plc:owner123", "YOUR_OWNER_DID"),
      );
      await writeFile(
        join(cwd, ".fads-install/oauth.jwks.json"),
        JSON.stringify([
          { kty: "EC", crv: "P-256", alg: "ES256", kid: "key", x: "x", y: "y", d: "secret" },
        ]),
      );

      const result = await runScript(checkInstall, cwd);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("DB.database_id");
      expect(result.stderr).toContain("queues.consumers.dead_letter_queue");
      expect(result.stderr).toContain("OWNER_DID");
      expect(result.stderr).not.toContain("secret");
      expect(result.stderr).not.toContain("YOUR_OWNER_DID");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("requires deployable config values and cryptographically importable key material", async () => {
    const cwd = await temporaryDirectory();
    try {
      await writeFile(
        join(cwd, "wrangler.install.jsonc"),
        validInstallConfig
          .replace("bc22303d-b8c0-45a0-9090-5b47557ebcac", "not-a-d1-id")
          .replace("https://reader.example", "https://owner:password@reader.example")
          .replace('"OWNER_DID": "did:plc:owner123", ', ""),
      );
      await writeFile(
        join(cwd, ".dev.vars"),
        "OWNER_DID=did:plc:owner123\nAPP_ORIGIN=https://reader.example\n",
      );
      await mkdir(join(cwd, ".fads-install"));
      await writeFile(
        join(cwd, ".fads-install/oauth.jwks.json"),
        JSON.stringify([
          {
            kty: "EC",
            crv: "P-256",
            alg: "ES256",
            kid: "key",
            x: "not-a-real-coordinate",
            y: "also-not-real",
            d: "not-a-real-private-key",
          },
        ]),
      );

      const result = await runScript(checkInstall, cwd);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("DB.database_id");
      expect(result.stderr).toContain("OWNER_DID");
      expect(result.stderr).toContain("APP_ORIGIN");
      expect(result.stderr).toContain("oauth.jwks.json");
      expect(result.stderr).not.toContain("password");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "worker name",
      (config: Record<string, unknown>) => {
        config.name = "fads-local";
      },
      "name",
    ],
    [
      "D1 migrations directory",
      (config: Record<string, any>) => {
        delete config.d1_databases[0].migrations_dir;
      },
      "DB.migrations_dir",
    ],
    [
      "owner session binding",
      (config: Record<string, any>) => {
        config.durable_objects.bindings = [];
      },
      "OWNER_SESSION",
    ],
    [
      "owner session migration",
      (config: Record<string, any>) => {
        config.migrations[0].new_sqlite_classes = [];
      },
      "migrations.new_sqlite_classes",
    ],
    [
      "cron schedule",
      (config: Record<string, any>) => {
        config.triggers.crons = [];
      },
      "triggers.crons",
    ],
  ])("rejects a missing %s deployment contract", async (_name, mutate, expectedError) => {
    const cwd = await temporaryDirectory();
    try {
      const config = JSON.parse(validInstallConfig) as Record<string, unknown>;
      mutate(config);
      await writeFile(join(cwd, "wrangler.install.jsonc"), JSON.stringify(config));
      expect((await runScript(generateKey, cwd)).code).toBe(0);

      const result = await runScript(checkInstall, cwd);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain(expectedError);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
