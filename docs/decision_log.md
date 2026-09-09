# Decisions

- 2026-09-08T20:48:09-04:00 — Build the reader and landing page together, using the original concept's language with a different visual style and a component library customized through our own tokens.
- 2026-09-08T20:48:09-04:00 — Initially selected public self-service access; superseded below by one-person self-hosting.
- 2026-09-08T20:48:09-04:00 — Use ATProto sign-in and ship the personal-reader scope. Keep the reader layer easy to modify; custom frontends can arrive through plugins or PR contributions.
- 2026-09-08T20:48:09-04:00 — Choose a bright digital playground visual direction and self-hosted-first distribution.
- 2026-09-08T20:48:09-04:00 — One person per installation, superseding public multi-user signup. The public site provides a demo and Cloudflare installation guidance.
- 2026-09-08T20:48:09-04:00 — Ship Focus, List, and Grid layouts with click-to-load images, audio, and video.
- 2026-09-08T20:48:09-04:00 — Approved implementation of the proposed plan: Astro/Svelte, shadcn-svelte with shared tokens, thin registered frames, onboarding and reliability fixes, separate static public build, and self-hosting instructions.

- 2026-09-08T21:49:49-04:00 — Merge the completed work, deploy the public landing page to fads.cc, and verify it live.

- 2026-09-08T22:22:19-04:00 — Preserve the first two landing-page sections; explain the remaining page for newcomers who may know ATProto, using SVGs and diagrams.

- 2026-09-08T22:36:57-04:00 — Use OKLCH colors and update normal text with inspiration from the Signage typography preset in compsys.

- 2026-09-09T12:18:00-04:00 — Make the existing homepage sections demonstrate intentionally different motion personalities because control over the interface is part of the product itself; preserve the current page rather than rehaul it.
- 2026-09-09T12:19:00-04:00 — Implement homepage motion native-first instead of adding an animation runtime.
- 2026-09-09T12:20:00-04:00 — Keep the award-winning homepage motion guidance as a reusable personal Codex skill.
- 2026-09-09T14:45:06-04:00 — Deploy the latest `main` build, clean up safely merged local Git state, and draft a short post explaining why f.ads could be compelling.
- 2026-09-09T14:54:24-04:00 — Write the launch post conversationally, opening with the recent discovery of ATProto and personal excitement about it.
