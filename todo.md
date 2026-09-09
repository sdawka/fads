# f.ads release handoff

Updated: 2026-09-08

The application is a self-hosted, single-owner reader. The separate public site includes the local demo and installation guide. The original concept remains preserved. The foundation is in [PR #1](https://github.com/sdawka/fads/pull/1); the reader and landing work is on `feat/reader-and-landing`.

## Implemented

- Shared tokens and shadcn-svelte components; Focus, List, and Grid use the same edition and progress.
- Click-to-load media with failure/retry controls, human-readable selection reasons, visible learned preferences, and source-removal confirmation.
- Immediate initial ingestion, automatically updated source status, bounded Queue batches, and a dead-letter queue required by installation preflight.
- Absolute offline-session expiry and clearing on authoritative sign-out, 401, logout, or full reset; late startup loads cannot restore expired content.
- Full-reset authentication cleanup and coordination with owner mutations and ingestion.
- Separate public static build, security headers, key generation, install validation, readiness probe, and redacted operational events.

## Local evidence

- App browser journeys: 24 passed, including accessibility, offline lifetime, safe media, and source status updates.
- Public-site browser journeys through Wrangler: 5 passed, including security headers, responsive widths, accessibility, and layout persistence.
- Install build and Wrangler dry run verified the generated Astro deployment config using non-production fixture values. No Cloudflare resources were provisioned.
- Dependency audit: zero vulnerabilities.
- Whole-tree formatting, lint, type checks, 254 unit tests, and 38 Worker integration tests pass. Seven existing Astro deprecation/style hints remain; Svelte reports zero warnings. CI results are recorded on the implementation PR.

## Before a live release

- [ ] Supply the real owner DID and stable HTTPS app origin; create the install-specific D1, ingestion queue, and dead-letter queue.
- [ ] Upload the private OAuth signing key and apply all D1 migrations using the [installation guide](README.md#host-your-own).
- [ ] Require every PR check green before merge. No merge or deployment has been performed for this change.
- [ ] Run real owner OAuth, wrong-owner rejection, RSS/ATProto ingestion, edition/feedback/keeps, offline replay, export, logout, and cross-session full-reset smoke tests.
- [ ] Configure Cloudflare alerts for queue failures, missing cron activity, elevated 5xx responses, and OAuth failures. Logs record categories/counts/statuses without private payloads.
- [ ] Rehearse compatible-code rollback and D1 recovery with an owner export and encrypted key backup.

## Deferred

- Stream/page large owner exports before long-term use can exceed Worker memory.
- Tune observability sampling after measuring actual traffic.
- Resolve existing dependency deprecation hints during the next upgrade.
- Multi-user hosting, runtime plugins, AI ranking, public profiles, and ATProto writes remain outside this build.
