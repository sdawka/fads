# f.ads

A private, single-owner reading surface for finite, explainable editions from ATProto and RSS. The original concept deck remains at `/concept/`.

## Host your own

You need a Cloudflare account, Node 22.12 or newer, and a stable HTTPS origin. The origin can be your custom domain or the Worker’s `workers.dev` address; it becomes the ATProto OAuth client identity, so choose it before the first sign-in.

```sh
git clone https://github.com/sdawka/fads.git fads
cd fads
npm ci
npx wrangler login
npx wrangler d1 create reader-db
npx wrangler queues create reader-ingestion
npx wrangler queues create reader-ingestion-dlq
cp wrangler.jsonc wrangler.install.jsonc
```

Edit the ignored `wrangler.install.jsonc` with a unique Worker `name`, the D1 `database_id` returned by the create command, a non-local D1 name, the primary queue name, and its `dead_letter_queue` name. Keep the existing Durable Object bindings, migrations, cron, and `migrations_dir`. Update the following fields and add the required public values under `vars`:

```jsonc
{
  "d1_databases": [{ "binding": "DB", "database_name": "reader-db", "database_id": "<D1 UUID>" }],
  "queues": {
    "producers": [{ "binding": "INGESTION_QUEUE", "queue": "reader-ingestion" }],
    "consumers": [{ "queue": "reader-ingestion", "dead_letter_queue": "reader-ingestion-dlq" }],
  },
  "vars": {
    "OWNER_DID": "did:plc:your-did",
    "APP_ORIGIN": "https://reader.example",
  },
}
```

`OWNER_DID` is the one ATProto identity allowed to enter. `APP_ORIGIN` must be an HTTPS root origin, without a path or credentials. These deployment values belong in `wrangler.install.jsonc`; `.dev.vars` is only for local development. Never put the private key in a config file or source control.

Generate the OAuth signing key once, store an encrypted backup somewhere separate, then add it as a Worker secret. The generator creates `.fads-install/oauth.jwks.json` with private filesystem permissions and refuses to overwrite an existing key.

```sh
npm run setup:key
npx wrangler secret put ATPROTO_OAUTH_PRIVATE_JWKS --config wrangler.install.jsonc < .fads-install/oauth.jwks.json
npm run setup:check
```

`setup:check` only verifies local configuration and the local JWK’s ES256/P-256 shape. It cannot prove that the Worker secret was uploaded or still matches the local file.

Apply the D1 migrations to the remote `DB` binding before deploying. `npm run deploy:install` performs the local check, builds with the install config, applies the remote migrations, and deploys Astro’s generated `dist/server/wrangler.json`, which includes the install bindings and compiled assets.

```sh
npx wrangler d1 migrations apply DB --remote --config wrangler.install.jsonc
npm run deploy:install
```

After the first source sync, confirm queue delivery by signing in as the configured DID and checking that the reader can load its first-source content. `/api/ready` is a read-only probe of local configuration, D1, and Durable Object availability; it does not prove Queue delivery or OAuth sign-in.

## Updates and recovery

Before an update, export the remote D1 database and retain the encrypted OAuth-key backup. These are Wrangler commands included by the pinned project CLI:

```sh
mkdir -p .fads-install/backups
npx wrangler d1 export reader-db --remote --config wrangler.install.jsonc --output .fads-install/backups/reader-db-before-update.sql
npm ci
npm run setup:check
npm run deploy:install
```

If a deployment must be rolled back, deploy the prior compatible revision with the same `wrangler.install.jsonc`. Do not restore an old database before checking that revision’s migrations are compatible. For a database recovery, inspect the available D1 point-in-time state, then replace the sample with the exact intended RFC3339 point within your account’s available retention window; never run restore without a specific timestamp:

```sh
npx wrangler d1 time-travel info reader-db --config wrangler.install.jsonc
npx wrangler d1 time-travel restore reader-db --config wrangler.install.jsonc --timestamp '<RFC3339 timestamp>'
```

Run a signed-in reader smoke afterwards: OAuth start, first-source content, and a reload of the private edition. Queue delivery is verified by that source smoke, not by deployment output alone.

## Architecture

The Worker holds the private boundary. It maps ATProto and RSS sources into typed content envelopes, applies the owner’s hard allowance and safety gates, then makes a bounded, explainable edition. D1 stores owner-scoped content, preferences, editions, and traces; `OwnerSessionDO` holds the OAuth session; the ingestion queue and cron keep sources current. OAuth uses a private ES256 key and exposes only the public JWK through the client metadata flow.

The reader is deliberately replaceable. Source adapters, the curation service, and the headless API sit behind typed contracts, so another private reader or presentation can use the same owner-controlled data and decision traces without publishing taste, history, or rankings to ATProto.

To add a reader frame, create a local Svelte component that accepts `ReaderFrameProps` from `src/components/reader/types.ts`, then add its ID, label, and component to `src/components/reader/registry.ts`. Frames run only from that local registry; the reader does not load executable extensions from URLs. The public marketing site is separate: use `npm run dev:site`, `npm run build:site`, and `npm run deploy:site` for its scripts.

## Local verification

Copy `.dev.vars.example` to `.dev.vars` and replace each placeholder. Apply local D1 migrations before exercising authenticated routes.

Run `npm run check`, `npm run test:real-worker`, and `npm run test:e2e`. Use `npm run dev` for the local app and `npm run cf-typegen` after changing Wrangler bindings.
