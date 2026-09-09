/* global console, process */

import { generateKeyPair, randomUUID } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const generate = promisify(generateKeyPair);

function outputPath(argumentsList) {
  if (argumentsList.length === 0) return resolve(".fads-install/oauth.jwks.json");
  if (argumentsList.length === 2 && argumentsList[0] === "--output" && argumentsList[1]) {
    return resolve(argumentsList[1]);
  }
  throw new Error("Usage: generate-oauth-key.mjs [--output path]");
}

async function main() {
  const output = outputPath(process.argv.slice(2));
  const directory = dirname(output);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);

  const { privateKey } = await generate("ec", { namedCurve: "P-256" });
  const jwk = privateKey.export({ format: "jwk" });
  const keys = [{ ...jwk, kid: randomUUID(), alg: "ES256" }];
  try {
    await writeFile(output, `${JSON.stringify(keys)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      throw new Error("OAuth key file already exists; refusing to overwrite it");
    }
    throw error;
  }
  await chmod(output, 0o600);
  console.log(`Created OAuth key file at ${output}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Could not create OAuth key file");
  process.exitCode = 1;
});
