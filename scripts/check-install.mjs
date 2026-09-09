/* global URL, console, process */

import { createPrivateKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "jsonc-parser";

const DEFAULT_CONFIG = "wrangler.install.jsonc";
const DEFAULT_KEY_FILE = ".fads-install/oauth.jwks.json";
const D1_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requestedConfig(argumentsList) {
  if (argumentsList.length === 0) return resolve(DEFAULT_CONFIG);
  if (argumentsList.length === 2 && argumentsList[0] === "--config" && argumentsList[1]) {
    return resolve(argumentsList[1]);
  }
  throw new Error("Usage: check-install.mjs [--config path]");
}

function hasPlaceholder(value) {
  return typeof value !== "string" || !value.trim() || /(?:replace|your[-_]|<[^>]+>)/i.test(value);
}

function isDid(value) {
  return (
    typeof value === "string" &&
    /^did:(?:plc|web):[A-Za-z0-9._:%-]+$/.test(value) &&
    !hasPlaceholder(value)
  );
}

function isWorkerName(value) {
  return !hasPlaceholder(value) && value !== "fads-local";
}

function isCronSchedule(value) {
  return typeof value === "string" && value.trim().split(/\s+/).length === 5;
}

function isRootHttpsOrigin(value) {
  if (hasPlaceholder(value)) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function validPrivateJwks(value) {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every((key) => {
    if (
      !key ||
      typeof key !== "object" ||
      key.kty !== "EC" ||
      key.crv !== "P-256" ||
      key.alg !== "ES256" ||
      !["kid", "x", "y", "d"].every(
        (field) => typeof key[field] === "string" && key[field].length > 0,
      )
    )
      return false;
    try {
      createPrivateKey({ key, format: "jwk" });
      return true;
    } catch {
      return false;
    }
  });
}

async function main() {
  const errors = [];
  let config = {};
  try {
    const configPath = requestedConfig(process.argv.slice(2));
    const parseErrors = [];
    config = parse(await readFile(configPath, "utf8"), parseErrors, { allowTrailingComma: true });
    if (parseErrors.length || !config || typeof config !== "object")
      errors.push("wrangler.install.jsonc");
  } catch {
    errors.push("wrangler.install.jsonc");
  }

  const databases = Array.isArray(config.d1_databases) ? config.d1_databases : [];
  const database = databases.find((entry) => entry?.binding === "DB");
  if (!isWorkerName(config.name)) errors.push("name");
  if (
    !database ||
    typeof database.database_id !== "string" ||
    !D1_ID.test(database.database_id) ||
    hasPlaceholder(database.database_id)
  )
    errors.push("DB.database_id");
  if (!database || hasPlaceholder(database.migrations_dir)) errors.push("DB.migrations_dir");

  const producers = Array.isArray(config.queues?.producers) ? config.queues.producers : [];
  const consumers = Array.isArray(config.queues?.consumers) ? config.queues.consumers : [];
  const producer = producers.find((entry) => entry?.binding === "INGESTION_QUEUE");
  if (!producer || hasPlaceholder(producer.queue)) errors.push("INGESTION_QUEUE");
  const consumer = consumers.find((entry) => entry?.queue === producer?.queue);
  if (!consumer || hasPlaceholder(consumer.dead_letter_queue))
    errors.push("queues.consumers.dead_letter_queue");

  const durableBindings = Array.isArray(config.durable_objects?.bindings)
    ? config.durable_objects.bindings
    : [];
  if (
    !durableBindings.some(
      (binding) => binding?.name === "OWNER_SESSION" && binding.class_name === "OwnerSessionDO",
    )
  ) {
    errors.push("OWNER_SESSION");
  }
  const migrations = Array.isArray(config.migrations) ? config.migrations : [];
  if (
    !migrations.some(
      (migration) =>
        Array.isArray(migration?.new_sqlite_classes) &&
        migration.new_sqlite_classes.includes("OwnerSessionDO"),
    )
  ) {
    errors.push("migrations.new_sqlite_classes");
  }
  const crons = Array.isArray(config.triggers?.crons) ? config.triggers.crons : [];
  if (!crons.some(isCronSchedule)) errors.push("triggers.crons");

  const vars = config.vars && typeof config.vars === "object" ? config.vars : {};
  if (!isDid(vars.OWNER_DID)) errors.push("OWNER_DID");
  if (!isRootHttpsOrigin(vars.APP_ORIGIN)) errors.push("APP_ORIGIN");

  try {
    if (!validPrivateJwks(JSON.parse(await readFile(resolve(DEFAULT_KEY_FILE), "utf8"))))
      errors.push("oauth.jwks.json");
  } catch {
    errors.push("oauth.jwks.json");
  }

  if (errors.length) {
    console.error(`Install check failed: ${[...new Set(errors)].join(", ")}`);
    process.exitCode = 1;
    return;
  }
  console.log("Install check passed.");
}

main().catch(() => {
  console.error("Install check failed: local configuration could not be read");
  process.exitCode = 1;
});
