# Task 5 offline report

## RED -> GREEN

- `npm exec vitest run test/unit/offline-policy.test.ts test/unit/offline-outbox.test.ts` -> RED: both suites failed with expected missing `src/modules/offline/policy` and `src/modules/offline/outbox` modules.
- Same focused command after implementation -> GREEN: 2 files, 13 tests passed.
- `npm exec vitest run test/unit/offline-client.test.ts test/unit/offline-policy.test.ts test/unit/offline-outbox.test.ts` -> GREEN: 3 files, 14 tests passed.
- Round 1 regression suite `npm exec vitest run test/unit/offline*.test.ts` -> GREEN: 5 files, 21 tests passed, including executable SW harness flows for body-preserving queueing, cached resume, and personal-state clearing.

## Verification

- Owned TypeScript strict check over `src/modules/offline/**` -> exit 0.
- `npm exec eslint -- public/sw.js src/modules/offline` -> exit 0.
- Prettier check over owned offline TypeScript/tests/manifest -> all matched.
- `npm run build` -> complete.
- `npm run typecheck` -> 0 errors (Astro emitted existing deprecation hints; Wrangler emitted a host log-file EPERM).
- `npx playwright test test/e2e/offline.spec.ts` could not start its configured Wrangler web server because the sandbox host denies Wrangler's log path and port 9229 (`EPERM`); no product assertion ran.

## Integration API

- Import from `src/modules/offline` (public index): `registerOfflineServiceWorker('/sw.js')`, `createIndexedDbOutbox()`, `queueOfflineMutation(request, store?)`, `replayOfflineMutations(store?)`, and `clearOfflineState(registration?)`.
- Call `registerOfflineServiceWorker()` once from the browser app shell; it also asks the worker to replay when the browser emits `online`. On logout or full reset call `clearOfflineState()`; it clears the IndexedDB outbox and sends `CLEAR_OFFLINE` to the active worker.
- The worker queues only same-origin `POST /api/v1/interactions` and `PATCH /api/v1/editions/:id/progress` requests with a bounded `Idempotency-Key`; payloads are validated before persistence. It replays in creation order, removes successful entries, pauses on transient errors, and retains permanent failures as `state: "failed"` for owner action.
- The worker caches only the install shell/offline fallback and a structurally validated `GET /api/v1/editions/active` response. OAuth/session/source/export/private arbitrary API requests and remote media are never admitted.
- Offline UI should use the active-edition cache only for resume; it must not create or synthesize an edition while disconnected.
- PNG icon conversion is deferred: no `rsvg-convert`, ImageMagick `magick`, or `convert` tooling is available in the build environment; SVG icons remain the shipped install assets.

## Round 1 fixes

- Clone queueable requests before network fetch so a failed fetch cannot consume the replay body.
- Added full response-shape validation through the frozen schemas plus duplicate IDs/positions and deep safe-block/media/trace checks in both policy and worker glue.
- Added shell-preserving personal-cache reset, offline active-edition read helper, outbox status/list helpers, online replay signaling, deterministic sequence ordering, IndexedDB unique idempotency index, transaction-completion settlement, and in-process replay serialization.
