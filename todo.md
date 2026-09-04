# f.ads release handoff

Last audited: 2026-09-03

## Release decision

The product is a coherent **private, single-owner alpha**, not a public or multi-user product. The core loop exists: owner ATProto sign-in, allowed sources, finite editions, decision traces, feedback, Keeps, explicit interests and suggestions, offline continuation, export, and reset.

Do not deploy the current checkout as production. It is roughly one focused hardening/release cycle away: estimate **2-4 engineering days**, then **3-7 days of real-owner dogfooding**. A public/multi-user beta is a separate phase and should wait until the private product proves useful.

Current repository state at audit time:

- `main` at `70fde10` contains only the preserved concept deck.
- The application is on `feat/first-build` at `6142fb6` before this handoff file.
- The worktree was clean, but no Git remote was configured. There is no remote CI, PR, deployment, or live smoke evidence.
- `wrangler.jsonc` still names local resources and contains an all-zero D1 ID. `.dev.vars.example` contains placeholders.

## Verified now

- [x] `npm run check`: formatting, lint, typecheck, 201 unit tests, and 36 Worker/D1 tests passed. Astro reported seven non-blocking deprecation/style hints.
- [x] `npm run test:real-worker`: build and both built-Worker tests passed.
- [x] `npx wrangler deploy --dry-run`: Wrangler correctly redirected from `wrangler.jsonc` to `dist/server/wrangler.json` and included Astro assets plus D1, Queue, Durable Object, KV session, Images, and Assets bindings. The existing `npm run deploy` shape is therefore valid after real production configuration is supplied.
- [ ] `npm run test:e2e`: did not start because the local Vite optimizer cache referenced a missing `node_modules/.vite/deps_ssr/astro_runtime_server_astro-global__js.js`. Re-run from a clean `npm ci` checkout and require green CI; do not classify this as an application failure unless it reproduces cleanly.
- [ ] `npm audit --audit-level=high`: current registry requests hung. The 2026-08-29 audit reported zero high vulnerabilities, but that is historical and must be refreshed before release.

## P0 — complete before the private alpha

### 1. Close the two bounded backend correctness gaps

- [ ] Chunk scheduled Queue fan-out into batches of at most 100 messages. `planStaleSourceSyncs()` can return every source, while `handleScheduled()` currently makes one `sendBatch()` call. OPML import is not capped, and Cloudflare limits `sendBatch()` to 100 messages or 256 KB.
  - Files: `src/worker-handlers.ts`, `test/unit/worker-handlers.test.ts`, possibly `src/modules/storage/index.ts`.
  - Acceptance: tests cover 101 and 201 stale sources; every batch is at most 100; no source is dropped.
  - Reference: <https://developers.cloudflare.com/queues/platform/limits/>

- [ ] Make “Full reset” clear every authentication artifact in `OwnerSessionDO`, not only app sessions and the owner OAuth session. Clear pending OAuth states, refresh locks, rate state, and private session events so a pre-reset authorization cannot complete afterward.
  - Files: `src/owner-session-do.ts`, `src/modules/auth/index.ts`, `src/modules/api/index.ts`, relevant auth/DO/reset tests.
  - Acceptance: start OAuth, perform full reset, then prove the old callback state cannot create a new app session; all DO-owned private state is empty.

### 2. Give offline private data an explicit lifetime

- [ ] Align the offline edition/outbox lifetime with the seven-day absolute app-session lifetime, and clear local private state whenever the server authoritatively reports signed out or expired. Today, a cached edition can be reopened indefinitely when the API is unreachable.
  - Files: `public/sw.js`, `src/components/AppShell.svelte`, offline unit and browser tests.
  - Acceptance: offline content works within the chosen window, expires afterward, and is purged after confirmed logout, full reset, or an authoritative unauthenticated response. Document the privacy trade-off in the Settings copy.

### 3. Fix the first-use path

- [ ] Queue an initial RSS refresh immediately after adding a source, as the ATProto flow already does.
- [ ] When an edition is empty because there are no sources/content, link to Sources and explain the actual next action. The current empty state points only to allowance settings.
- [ ] Show source `lastSyncedAt`, last error, and a clear queued/syncing/ready state so the owner knows when content is available.
  - Files: `src/components/AppShell.svelte`, API/UI tests, and possibly `src/modules/api/index.ts` if queueing moves server-side.
  - Acceptance: a new owner can sign in, add one source, see ingestion complete, and create a non-empty edition without guessing or waiting for the 15-minute cron.

### 4. Create a real staging and production delivery path

- [ ] Configure a verified Git remote, push the branch, open a PR, and require every CI check to be green before merge.
- [ ] Add deliberate staging/production Wrangler environments or separate configs. Replace local Worker/Queue names and the zero D1 ID; keep the Astro-generated deploy redirect intact.
- [ ] Provision D1, Queue, Durable Object migration, the HTTPS app origin/custom domain, and the configured owner DID.
- [ ] Install `ATPROTO_OAUTH_PRIVATE_JWKS` as a Worker secret. Restrict accepted production keys to the advertised `ES256` / EC P-256 shape, or derive OAuth metadata from the configured key.
- [ ] Apply all three D1 migrations remotely before the first application smoke.
- [ ] Run a clean install, the full CI workflow, a current high-severity dependency audit, and `wrangler deploy --dry-run` against the release configuration.

### 5. Prove the real system, not only mocks

- [ ] In staging, complete real owner OAuth start/callback/refresh/revoke against the intended PDS and verify DPoP plus wrong-owner rejection.
- [ ] Exercise real RSS and ATProto ingestion through Queue and cron, including redirects, transient failures, retries, duplicate work, and more than 100 sources.
- [ ] Exercise edition creation, progress, reactions, Keeps, offline resume/replay, export, logout, and full reset against deployed D1/DO state.
- [ ] Verify the live CSP/security headers and confirm another browser session is invalidated by full reset.

### 6. Add minimum operations and recovery

- [ ] Configure a dead-letter queue. Default exhausted Queue retries are otherwise deleted.
- [ ] Add redacted structured logs for OAuth, API failures, queue attempts, cron planning, and ingestion outcomes. Never log tokens, JWKs, private content, or full external responses.
- [ ] Add alerting for repeated queue failures, cron silence, elevated 5xx responses, and OAuth failures.
- [ ] Add a readiness check or release smoke that validates runtime configuration and essential bindings. `/api/health` currently returns `ok` without touching them.
- [ ] Record and rehearse rollback plus D1 recovery. Take a validated owner export before destructive migration/reset tests.
  - Reference: <https://developers.cloudflare.com/queues/configuration/batching-retries/>

## P1 — early dogfood, before calling it dependable

- [ ] Stream or page the owner export. It currently loads all retained content/history concurrently and serializes one unbounded JSON object; long-term use can exceed Worker memory even though export is a core promise.
- [ ] Add a live view of learned ranking adjustments. The Garden currently says they are visible only in the JSON export.
- [ ] Add confirmation or undo for source removal. Removal immediately hides the source while its content is retained for export, a lifecycle that is easy to misunderstand; Keep removal can use a lightweight undo.
- [ ] Decide whether 100% observability sampling is appropriate after measuring private-alpha traffic and log volume.
- [ ] Resolve the current deprecation hints during the next dependency upgrade, not as a release blocker.

## Do not build yet

- Multi-user tenancy, public profiles, sharing, social mechanics, and a generalized onboarding funnel are not needed for the private alpha.
- Do not broaden OAuth permissions or publish taste/history into ATProto records.
- Do not add more ranking sophistication until real use shows that the finite-edition loop, feedback controls, and explanations are valuable.

## Release gate

Release only when P0 is complete, the PR has all-green CI, a production-equivalent staging smoke passes with the real owner/PDS, recovery and rollback have been rehearsed, and the deployed production URL passes the same authenticated smoke.
