# UI/API wiring report

## Scope

- Expanded `createBrowserUiClient` and `FadsUiClient` for keeps, sources, OPML, garden, preferences, export, reset, and logout.
- Replaced Keeps, Sources, Garden, and Settings placeholder state in `AppShell.svelte` with authenticated client-backed loading and mutations.
- Kept edition behavior intact while adding durable keep persistence, progress rollback, one-time service-worker registration, and offline-state clearing after logout/full reset.

## TDD evidence

- RED: `test/unit/ui-management-client.test.ts` initially failed because management client methods did not exist.
- GREEN: `npx vitest run test/unit/ui-client.test.ts test/unit/ui-management-client.test.ts --run` -> 2 files, 7 tests passed.
- Boundary coverage includes route/method mapping, idempotency headers, strict source/interest/suggestion/preferences parsing, OPML/import/export handling, no-content mutations, reset payloads, and malformed response rejection.

## Verification

- `npx eslint src/components` -> pass.
- `npx prettier --check src/components/api-client.ts src/components/models.ts test/unit/ui-management-client.test.ts` -> pass.
- `npx astro check` -> 0 errors (existing deprecation notices remain elsewhere).
- Full `npm run typecheck` remains blocked by the concurrent storage export type error in `src/modules/storage/index.ts:508`; that file is outside this UI slice.

## Contract notes

- The API has no shared Zod response schema for `KeepRecord`, `OwnerExport`, or OPML export/import. The browser client uses isolated strict parsers for the exact current storage/API shapes and rejects malformed values; these should move to `src/contracts/api.ts` when the API contract is extended.
- There is no source-specific mute route. Source mute/unmute is persisted through the existing strict `PUT /api/v1/preferences` route by updating `mutedSourceIds`.
- Confirming a suggestion currently changes its suggestion status through the existing API. The UI does not fabricate a manual-interest record because the current backend route does not create one.
