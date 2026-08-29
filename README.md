# f.ads

A private, single-owner reading surface for finite, explainable editions from ATProto and RSS. The original concept deck remains unchanged at `/concept/`.

## Architecture

- `src/contracts` owns Zod-validated shared data contracts.
- `src/modules/curation` applies hard allowances before deterministic ranking, bounded surprise, and the twelve-item edition limit.
- `src/modules/api` exposes the authenticated owner API with atomic idempotency; `src/modules/storage` owns D1 persistence and owner scoping.
- `src/modules/sources` normalizes ATProto home/custom feeds and SSRF-safe RSS into validated content envelopes.
- `src/worker.ts` mounts OAuth and private API routes before Astro, while Queue and cron handlers synchronize sources and create review-only interest suggestions.
- `OwnerSessionDO` stores the owner OAuth/app session. Only the validated active edition and an allowlisted mutation outbox are available offline.

## Local verification

Copy `.dev.vars.example` to `.dev.vars` and replace every placeholder with the test owner DID, HTTPS app origin, and private OAuth JWK. Apply the D1 migrations before exercising authenticated routes.

Run `npm run check`, `npm run test:real-worker`, and `npm run test:e2e`. Use `npm run dev` for the local app and `npm run cf-typegen` after changing Wrangler bindings.

Production deployment intentionally waits for the real Cloudflare resource IDs, ingestion queue, owner DID, app origin, and OAuth key material. Secrets belong in Worker secrets or `.dev.vars`, never in the repository.
