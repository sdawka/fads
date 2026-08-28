# f.ads

A private, deliberate reading surface. This repository is the first production-capable foundation; the original concept deck remains unchanged at `/concept/`.

## Architecture

- `src/contracts` owns Zod-validated shared data contracts.
- `src/worker.ts` is the Cloudflare Worker entrypoint: API traffic stays in the Worker and all other traffic delegates to Astro.
- D1 holds shared source, content, edition, interaction, and idempotency data. Structured blocks, media, and decision traces are validated before JSON serialization.
- `OwnerSessionDO` provides a per-owner SQLite-backed coordination boundary; the ingestion queue and scheduled handler are intentionally observable but minimal.

Run `npm install`, then `npm run check`. Use `npm run dev` for local Astro development and `npm run cf-typegen` after changing Wrangler bindings.
