import { describe, expect, it } from "vitest";

import {
  EditionResponseSchema,
  IdempotencyKeySchema,
  InteractionCreateSchema,
  OwnerExportSchema,
  ProblemSchema,
  SourceCreateSchema,
} from "../../src/contracts/api";
import {
  createOwnerApiHandler,
  upsertOwnerBootstrapSuggestions,
  type OwnerApiDependencies,
} from "../../src/modules/api";
import type {
  IdempotencyClaimInput,
  OwnerDataRepository,
  OwnerSource,
  OwnerStorageHardeningRepository,
} from "../../src/modules/storage";

const OWNER = "did:plc:owner";
const AT = "2026-08-28T12:00:00.000Z";

type ApiRepository = OwnerDataRepository & OwnerStorageHardeningRepository;

function source(overrides: Partial<OwnerSource> = {}): OwnerSource {
  return {
    id: "rss:one",
    ownerId: "did:plc:owner",
    adapter: "rss",
    displayName: "One",
    url: "https://example.com/feed.xml",
    config: {},
    status: "idle",
    createdAt: "2026-08-28T12:00:00.000Z",
    updatedAt: "2026-08-28T12:00:00.000Z",
    ...overrides,
  };
}

function content(id: string, sourceId = "rss:one") {
  return {
    id,
    canonicalUri: `https://example.com/${id}`,
    sourceId,
    publishedAt: AT,
    capturedAt: AT,
    blocks: [{ kind: "paragraph" as const, text: id }],
    media: [],
    tags: [{ value: "systems", provenance: { source: "rss", observedAt: AT } }],
    labels: [],
  };
}

function slate(ids: string[] = ["item:one"]) {
  return {
    id: "edition:one",
    ownerId: OWNER,
    createdAt: AT,
    curiosity: 50,
    energy: 50,
    items: ids.map((contentId, position) => ({
      id: `frame:${position}`,
      contentId,
      frame: "read",
      position,
      decisionTrace: { factors: [] },
    })),
    decisionTrace: { factors: [] },
  };
}

function validExport(ownerId = OWNER) {
  return {
    ownerId,
    exportedAt: AT,
    data: {
      sources: [],
      syncCursors: [],
      content: [],
      interests: [],
      suggestions: [],
      preferences: { blockedLabels: [], mutedSourceIds: [] },
      learnedAdjustments: [],
      suppressions: [],
      interactions: [],
      keeps: [],
      editions: [],
      editionItems: [],
      editionDecisions: [],
      progress: [],
    },
  };
}

function repository(): ApiRepository {
  const sources = new Map<string, OwnerSource>();
  const contents = new Map<string, ReturnType<typeof content>>([["item:one", content("item:one")]]);
  const idempotency = new Map<
    string,
    {
      requestHash: string;
      state: "pending" | "completed";
      claimToken: string;
      response?: Response;
      expiresAt: string;
    }
  >();
  return {
    listSources: async (ownerId) =>
      [...sources.values()].filter((item) => item.ownerId === ownerId),
    getSource: async (ownerId, sourceId) => {
      const item = sources.get(sourceId);
      return item?.ownerId === ownerId ? item : undefined;
    },
    saveSource: async (item) => {
      sources.set(item.id, item);
      return item;
    },
    removeSource: async (ownerId, sourceId) =>
      sources.get(sourceId)?.ownerId === ownerId ? sources.delete(sourceId) : false,
    setSourceStatus: async (ownerId, sourceId, status) => {
      const item = sources.get(sourceId);
      if (!item || item.ownerId !== ownerId) return undefined;
      const updated = { ...item, ...status };
      sources.set(sourceId, updated);
      return updated;
    },
    listInterests: async () => [],
    saveInterest: async (item) => item,
    removeInterest: async () => false,
    listSuggestions: async () => [],
    decideSuggestion: async () => undefined,
    getPreferences: async () => ({ blockedLabels: [], mutedSourceIds: [] }),
    savePreferences: async (_ownerId, value) => value,
    listCandidates: async () => [],
    getCurationState: async () => ({ learnedAdjustments: {}, notNow: [], recentlyShown: [] }),
    recordInteraction: async (event) => event,
    listKeeps: async () => [],
    saveKeep: async (item) => item,
    removeKeep: async () => false,
    exportOwnerData: async (ownerId) => validExport(ownerId),
    resetOwnerData: async () => undefined,
    getIdempotentResponse: async (input) => {
      const record = idempotency.get(`${input.ownerId}:${input.scope}:${input.key}`);
      if (!record) return undefined;
      if (record.requestHash !== input.requestHash) return { conflict: true as const };
      if (!record.response) return undefined;
      return { conflict: false as const, response: record.response.clone() };
    },
    saveIdempotentResponse: async (input) => {
      idempotency.set(`${input.ownerId}:${input.scope}:${input.key}`, {
        requestHash: input.requestHash,
        state: "completed",
        claimToken: "legacy",
        response: input.response.clone(),
        expiresAt: input.expiresAt,
      });
    },
    claimIdempotency: async (input: IdempotencyClaimInput) => {
      const key = `${input.ownerId}:${input.scope}:${input.key}`;
      const current = idempotency.get(key);
      if (current && current.expiresAt > input.now) {
        if (current.requestHash !== input.requestHash) return { status: "conflict" as const };
        if (current.state === "completed" && current.response) {
          return { status: "completed" as const, response: current.response.clone() };
        }
        return { status: "pending" as const };
      }
      const claimToken = input.claimToken ?? crypto.randomUUID();
      idempotency.set(key, {
        requestHash: input.requestHash,
        state: "pending",
        claimToken,
        expiresAt: input.expiresAt,
      });
      return { status: "claimed" as const, claimToken };
    },
    completeIdempotency: async (input) => {
      const key = `${input.ownerId}:${input.scope}:${input.key}`;
      const current = idempotency.get(key);
      if (!current || current.claimToken !== input.claimToken || current.state !== "pending")
        return false;
      current.state = "completed";
      current.response = input.response.clone();
      return true;
    },
    hydrateContent: async (ownerId, ids) =>
      ownerId === OWNER
        ? ids.flatMap((contentId) => (contents.has(contentId) ? [contents.get(contentId)!] : []))
        : [],
    importSourcesAtomically: async (_ownerId, input) => ({ inserted: [...input], duplicates: [] }),
    upsertBootstrapSuggestions: async (_ownerId, input) => [...input],
    listConfirmedSuggestions: async () => [],
    getContentContext: async (ownerId, contentId) => {
      const item = ownerId === OWNER ? contents.get(contentId) : undefined;
      return item
        ? {
            contentId,
            sourceId: item.sourceId,
            canonicalUri: item.canonicalUri,
            format: "paragraph",
            tags: ["systems"],
            labels: [],
          }
        : undefined;
    },
    validateEditionContentMembership: async (ownerId, editionId, contentId) =>
      ownerId === OWNER && editionId === "edition:one" && contentId === "item:one",
    claimSyncWork: async () => ({ status: "claimed", claimToken: "sync" }),
    completeSyncWork: async () => true,
    releaseSyncWork: async () => true,
  };
}

function dependencies(overrides: Partial<OwnerApiDependencies> = {}): OwnerApiDependencies {
  return {
    ownerDid: OWNER,
    authenticate: async () => ({ did: OWNER }),
    logout: async () => new Response(null, { status: 204 }),
    repository: repository(),
    editions: {
      create: async () => ({ edition: undefined, selected: [] }),
      resume: async () => undefined,
      setPosition: async () => undefined,
      complete: async () => undefined,
    },
    now: () => AT,
    id: () => "rss:one",
    ...overrides,
  };
}

describe("owner API contracts", () => {
  it("rejects unknown source fields and unbounded idempotency keys", () => {
    expect(() =>
      SourceCreateSchema.parse({
        adapter: "rss",
        displayName: "Example",
        url: "https://example.com/feed.xml",
        surprise: true,
      }),
    ).toThrow();
    expect(() => IdempotencyKeySchema.parse("x".repeat(129))).toThrow();
  });

  it("keeps problem documents strict and typed", () => {
    expect(
      ProblemSchema.parse({
        type: "https://fads.cc/problems/validation",
        title: "Invalid request",
        status: 400,
        detail: "The request body is invalid.",
      }),
    ).toMatchObject({ status: 400 });
    expect(() =>
      ProblemSchema.parse({ type: "x", title: "x", status: 400, secret: "no" }),
    ).toThrow();
  });

  it("uses a strict interaction contract for each feedback kind", () => {
    for (const kind of [
      "more_like_this",
      "less_like_this",
      "good_surprise",
      "not_now",
      "keep",
    ] as const) {
      expect(
        InteractionCreateSchema.parse({ editionId: "edition:one", contentId: "item:one", kind }),
      ).toMatchObject({ kind });
      expect(() => InteractionCreateSchema.parse({ contentId: "item:one", kind })).toThrow();
    }
    expect(
      InteractionCreateSchema.parse({ sourceId: "rss:one", kind: "mute_source" }),
    ).toMatchObject({ kind: "mute_source" });
    expect(() => InteractionCreateSchema.parse({ kind: "mute_source" })).toThrow();
    expect(() =>
      InteractionCreateSchema.parse({
        editionId: "edition:one",
        contentId: "item:one",
        kind: "keep",
        factor: "client",
      }),
    ).toThrow();
  });

  it("publishes reusable strict edition and export response schemas", () => {
    expect(
      EditionResponseSchema.parse({
        edition: slate(),
        content: [content("item:one")],
        position: 0,
        completed: false,
      }),
    ).toBeTruthy();
    expect(OwnerExportSchema.parse(validExport())).toBeTruthy();
    expect(() => OwnerExportSchema.parse({ ...validExport(), extra: true })).toThrow();
  });

  it("validates the private bootstrap persistence seam", async () => {
    const repo = repository();
    const suggestion = {
      id: "suggestion:one",
      ownerId: OWNER,
      value: "systems",
      evidenceCount: 2,
      provenance: { source: "atproto" },
      status: "pending" as const,
      createdAt: AT,
    };
    expect(await upsertOwnerBootstrapSuggestions(repo, OWNER, [suggestion])).toEqual([suggestion]);
    await expect(
      upsertOwnerBootstrapSuggestions(repo, OWNER, [{ ...suggestion, ownerId: "did:plc:other" }]),
    ).rejects.toThrow(/owner mismatch/i);
  });
});

describe("owner API router", () => {
  it("requires the configured owner before touching private state", async () => {
    const handler = createOwnerApiHandler(
      dependencies({ authenticate: async () => ({ did: "did:plc:someone-else" }) }),
    );
    const response = await handler(new Request("https://fads.cc/api/v1/sources"));

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-type")).toContain("application/problem+json");
  });

  it("returns owner-scoped sources with private no-store headers", async () => {
    const repo = repository();
    await repo.saveSource(source());
    await repo.saveSource(source({ id: "rss:other", ownerId: "did:plc:other" }));
    const handler = createOwnerApiHandler(dependencies({ repository: repo }));

    const response = await handler(new Request("https://fads.cc/api/v1/sources"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ sources: [source()] });
  });

  it("forwards the logout cookie deletion through the private API", async () => {
    const handler = createOwnerApiHandler(
      dependencies({
        logout: async () =>
          new Response(null, {
            status: 204,
            headers: {
              "set-cookie": "fads_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0",
            },
          }),
      }),
    );

    const response = await handler(
      new Request("https://fads.cc/api/v1/logout", {
        method: "POST",
        headers: { "idempotency-key": "logout" },
      }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie")).toBe(
      "fads_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0",
    );
  });

  it("revokes authentication and clears the cookie after a full reset", async () => {
    let fullReset = false;
    let loggedOut = false;
    let allSessions = false;
    const repo = repository();
    repo.resetOwnerData = async (_ownerId, full) => {
      fullReset = full;
    };
    const handler = createOwnerApiHandler(
      dependencies({
        repository: repo,
        logout: async (_request, options) => {
          loggedOut = true;
          allSessions = options?.allSessions === true;
          return new Response(null, {
            status: 204,
            headers: { "set-cookie": "fads_session=; Path=/; Max-Age=0" },
          });
        },
      }),
    );

    const response = await handler(
      new Request("https://fads.cc/api/v1/reset", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "full-reset" },
        body: JSON.stringify({ full: true, confirmation: "DELETE ALL PRIVATE DATA" }),
      }),
    );

    expect(fullReset).toBe(true);
    expect(loggedOut).toBe(true);
    expect(allSessions).toBe(true);
    expect(response.headers.get("set-cookie")).toBe("fads_session=; Path=/; Max-Age=0");
  });

  it("replays an idempotent source mutation and rejects key reuse with another body", async () => {
    const handler = createOwnerApiHandler(dependencies());
    const request = (displayName: string) =>
      new Request("https://fads.cc/api/v1/sources", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "source-one" },
        body: JSON.stringify({ adapter: "rss", displayName, url: "https://example.com/feed.xml" }),
      });

    const first = await handler(request("One"));
    const replay = await handler(request("One"));
    const conflict = await handler(request("Different"));

    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotent-replay")).toBe("true");
    expect(await replay.json()).toEqual(await first.json());
    expect(conflict.status).toBe(409);
  });

  it("reclaims an expired idempotency key for a new request", async () => {
    let current = AT;
    const handler = createOwnerApiHandler(dependencies({ now: () => current }));
    const request = (displayName: string) =>
      new Request("https://fads.cc/api/v1/sources", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "expiring" },
        body: JSON.stringify({
          adapter: "rss",
          displayName,
          url: "https://example.com/feed.xml",
        }),
      });

    expect((await handler(request("One"))).status).toBe(201);
    current = "2026-08-30T12:00:00.000Z";
    expect((await handler(request("Two"))).status).toBe(201);
  });

  it("claims concurrent mutations before running the domain operation", async () => {
    const repo = repository();
    let saves = 0;
    repo.saveSource = async (item) => {
      saves += 1;
      return item;
    };
    const handler = createOwnerApiHandler(dependencies({ repository: repo }));
    const request = () =>
      new Request("https://fads.cc/api/v1/sources", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "concurrent" },
        body: JSON.stringify({
          adapter: "rss",
          displayName: "One",
          url: "https://example.com/feed.xml",
        }),
      });

    const responses = await Promise.all([handler(request()), handler(request())]);

    expect(saves).toBe(1);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 425]);
  });

  it("matches route segments exactly and reports methods before idempotency", async () => {
    const repo = repository();
    await repo.saveSource(source());
    const handler = createOwnerApiHandler(dependencies({ repository: repo }));

    const wrongMethod = await handler(
      new Request("https://fads.cc/api/v1/sources", { method: "PUT" }),
    );
    const suffix = await handler(
      new Request("https://fads.cc/api/v1/sources/rss%3Aone/unexpected", {
        method: "DELETE",
        headers: { "idempotency-key": "suffix" },
      }),
    );

    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("GET, POST");
    expect(suffix.status).toBe(404);
    expect(await repo.getSource(OWNER, "rss:one")).toBeTruthy();
  });

  it("rejects request bodies above the API ceiling before JSON parsing", async () => {
    const handler = createOwnerApiHandler(dependencies());
    const response = await handler(
      new Request("https://fads.cc/api/v1/sources", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(2 * 1024 * 1024 + 1),
          "idempotency-key": "large",
        },
        body: "{}",
      }),
    );

    expect(response.status).toBe(413);
  });

  it("rejects malformed JSON and unknown routes without exposing parser details", async () => {
    const handler = createOwnerApiHandler(dependencies());
    const malformed = await handler(
      new Request("https://fads.cc/api/v1/sources", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "bad-json" },
        body: "{",
      }),
    );
    const missing = await handler(new Request("https://fads.cc/api/v1/nope"));

    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ title: "Invalid request", status: 400 });
    expect(missing.status).toBe(404);
  });

  it("resumes the active edition and accepts a frozen feedback action", async () => {
    let resumedId: string | undefined = "not-called";
    let recordedKind: string | undefined;
    const repo = repository();
    await repo.saveSource(source());
    repo.recordInteraction = async (event) => {
      recordedKind = event.kind;
      return event;
    };
    const handler = createOwnerApiHandler(
      dependencies({
        repository: repo,
        editions: {
          create: async () => ({ selected: [] }),
          resume: async (_ownerId, editionId) => {
            resumedId = editionId;
            return { edition: slate(), position: 0, completed: false };
          },
          setPosition: async () => undefined,
          complete: async () => undefined,
        },
      }),
    );

    const active = await handler(new Request("https://fads.cc/api/v1/editions/active"));
    const feedback = await handler(
      new Request("https://fads.cc/api/v1/interactions", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "feedback-one" },
        body: JSON.stringify({
          editionId: "edition:one",
          contentId: "item:one",
          sourceId: "rss:one",
          kind: "good_surprise",
        }),
      }),
    );

    expect(active.status).toBe(200);
    expect(resumedId).toBeUndefined();
    expect(feedback.status).toBe(201);
    expect(recordedKind).toBe("good_surprise");
  });

  it("hydrates only edition item identifiers in slate order", async () => {
    const repo = repository();
    const candidates = Array.from({ length: 13 }, (_, index) => content(`candidate:${index}`));
    let hydrated: readonly string[] = [];
    repo.listCandidates = async () => candidates;
    repo.hydrateContent = async (_ownerId, ids) => {
      hydrated = ids;
      return ids.map((item) => content(item));
    };
    const handler = createOwnerApiHandler(
      dependencies({
        repository: repo,
        editions: {
          create: async () => ({
            slate: slate(["candidate:9", "candidate:2"]),
            selected: candidates,
          }),
          resume: async () => undefined,
          setPosition: async () => undefined,
          complete: async () => undefined,
        },
      }),
    );

    const response = await handler(
      new Request("https://fads.cc/api/v1/editions", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "edition" },
        body: JSON.stringify({ curiosity: 50, energy: 50, limit: 2 }),
      }),
    );

    expect(response.status).toBe(201);
    expect(hydrated).toEqual(["candidate:9", "candidate:2"]);
    const body = (await response.json()) as { content: Array<{ id: string }> };
    expect(body.content.map((item) => item.id)).toEqual(["candidate:9", "candidate:2"]);
  });

  it("rejects malformed edition domain responses instead of leaking them", async () => {
    const handler = createOwnerApiHandler(
      dependencies({
        editions: {
          create: async () => ({ selected: [] }),
          resume: async () => ({ edition: { id: "broken" }, position: 0, completed: false }),
          setPosition: async () => undefined,
          complete: async () => undefined,
        },
      }),
    );

    const response = await handler(new Request("https://fads.cc/api/v1/editions/active"));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ title: "Upstream operation failed" });
  });

  it("passes only confirmed bootstrap suggestions into curation", async () => {
    const repo = repository();
    repo.listConfirmedSuggestions = async () => ["systems", "type theory"];
    let confirmed: readonly string[] | undefined;
    const handler = createOwnerApiHandler(
      dependencies({
        repository: repo,
        editions: {
          create: async (_request, _candidates, options) => {
            confirmed = options.confirmedInterests;
            return { slate: slate([]), selected: [] };
          },
          resume: async () => undefined,
          setPosition: async () => undefined,
          complete: async () => undefined,
        },
      }),
    );

    const response = await handler(
      new Request("https://fads.cc/api/v1/editions", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "confirmed" },
        body: JSON.stringify({ curiosity: 50, energy: 50 }),
      }),
    );

    expect(response.status).toBe(201);
    expect(confirmed).toEqual(["systems", "type theory"]);
  });

  it("shows only pending bootstrap suggestions for owner review", async () => {
    const repo = repository();
    const suggestion = {
      id: "suggestion:systems",
      ownerId: OWNER,
      value: "systems",
      evidenceCount: 2,
      provenance: { source: "bootstrap", observedAt: AT },
      createdAt: AT,
    } as const;
    repo.listSuggestions = async () => [
      { ...suggestion, status: "pending" },
      { ...suggestion, id: "suggestion:confirmed", status: "confirmed", decidedAt: AT },
      { ...suggestion, id: "suggestion:rejected", status: "rejected", decidedAt: AT },
    ];
    const handler = createOwnerApiHandler(dependencies({ repository: repo }));

    const response = await handler(new Request("https://fads.cc/api/v1/suggestions"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      suggestions: [{ ...suggestion, status: "pending" }],
    });
  });

  it("validates interaction membership and derives its source from stored content", async () => {
    const repo = repository();
    await repo.saveSource(source());
    let recorded: unknown;
    repo.recordInteraction = async (event) => {
      recorded = event;
      return event;
    };
    const handler = createOwnerApiHandler(dependencies({ repository: repo }));
    const interact = (key: string, body: unknown) =>
      handler(
        new Request("https://fads.cc/api/v1/interactions", {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": key },
          body: JSON.stringify(body),
        }),
      );

    expect(
      (
        await interact("valid-feedback", {
          editionId: "edition:one",
          contentId: "item:one",
          kind: "more_like_this",
        })
      ).status,
    ).toBe(201);
    expect(recorded).toMatchObject({ contentId: "item:one", sourceId: "rss:one" });
    expect(
      (
        await interact("wrong-source", {
          editionId: "edition:one",
          contentId: "item:one",
          sourceId: "rss:other",
          kind: "less_like_this",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await interact("wrong-edition", {
          editionId: "edition:other",
          contentId: "item:one",
          kind: "not_now",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await interact("missing-content", {
          editionId: "edition:one",
          contentId: "item:missing",
          kind: "keep",
        })
      ).status,
    ).toBe(404);
  });

  it("records keep feedback through the atomic interaction mutation", async () => {
    const repo = repository();
    await repo.saveSource(source());
    let interactionKind: string | undefined;
    let standaloneKeepWrites = 0;
    repo.recordInteraction = async (event) => {
      interactionKind = event.kind;
      return event;
    };
    repo.saveKeep = async (keep) => {
      standaloneKeepWrites += 1;
      return keep;
    };
    const handler = createOwnerApiHandler(dependencies({ repository: repo }));

    const response = await handler(
      new Request("https://fads.cc/api/v1/interactions", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "keep-offline" },
        body: JSON.stringify({
          editionId: "edition:one",
          contentId: "item:one",
          kind: "keep",
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(interactionKind).toBe("keep");
    expect(standaloneKeepWrites).toBe(0);
  });

  it("validates and records a source-only mute interaction", async () => {
    const repo = repository();
    await repo.saveSource(source());
    let recorded: unknown;
    repo.recordInteraction = async (event) => {
      recorded = event;
      return event;
    };
    const handler = createOwnerApiHandler(dependencies({ repository: repo }));

    const response = await handler(
      new Request("https://fads.cc/api/v1/interactions", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "mute-source" },
        body: JSON.stringify({ sourceId: "rss:one", kind: "mute_source" }),
      }),
    );

    expect(response.status).toBe(201);
    expect(recorded).toMatchObject({ kind: "mute_source", sourceId: "rss:one" });
    expect(recorded).not.toHaveProperty("contentId");
  });

  it("returns owner-scoped content previews alongside keep records", async () => {
    const repo = repository();
    repo.listKeeps = async () => [{ ownerId: OWNER, contentId: "item:one", keptAt: AT }];
    const handler = createOwnerApiHandler(dependencies({ repository: repo }));

    const response = await handler(new Request("https://fads.cc/api/v1/keeps"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      keeps: [{ ownerId: OWNER, contentId: "item:one", keptAt: AT }],
      content: [content("item:one")],
    });
  });

  it("uses atomic OPML import and validates owner exports", async () => {
    const repo = repository();
    let atomicImports = 0;
    repo.importSourcesAtomically = async (_ownerId, input) => {
      atomicImports += 1;
      return { inserted: [...input], duplicates: [] };
    };
    const handler = createOwnerApiHandler(dependencies({ repository: repo }));
    const opml = await handler(
      new Request("https://fads.cc/api/v1/sources/opml", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "opml" },
        body: JSON.stringify({
          opml: '<?xml version="1.0"?><opml version="2.0"><body><outline text="One" type="rss" xmlUrl="https://example.com/feed.xml" /></body></opml>',
        }),
      }),
    );
    expect(opml.status).toBe(201);
    expect(atomicImports).toBe(1);

    repo.exportOwnerData = async () => ({ ...validExport(), data: {} }) as never;
    const invalidExport = await handler(new Request("https://fads.cc/api/v1/export"));
    expect(invalidExport.status).toBe(502);
  });

  it("returns bounded OPML rejections when an outline has no URL", async () => {
    const handler = createOwnerApiHandler(dependencies());
    const response = await handler(
      new Request("https://fads.cc/api/v1/sources/opml", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "opml-rejected" },
        body: JSON.stringify({
          opml: '<?xml version="1.0"?><opml version="2.0"><body><outline text="Missing" /></body></opml>',
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      sources: [],
      rejected: [{ url: "", reason: "Missing xmlUrl" }],
    });
  });

  it("validates keep membership and refuses refresh without a queue", async () => {
    const repo = repository();
    await repo.saveSource(source());
    const handler = createOwnerApiHandler(
      dependencies({ repository: repo, enqueueSource: undefined }),
    );
    const keep = await handler(
      new Request("https://fads.cc/api/v1/keeps", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "bad-keep" },
        body: JSON.stringify({ contentId: "missing" }),
      }),
    );
    const refresh = await handler(
      new Request("https://fads.cc/api/v1/sources/rss%3Aone/refresh", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "refresh" },
        body: "{}",
      }),
    );

    expect(keep.status).toBe(404);
    expect(refresh.status).toBe(502);
    expect((await repo.getSource(OWNER, "rss:one"))?.status).toBe("idle");
  });

  it("rejects malformed payloads on otherwise bodyless mutations", async () => {
    const repo = repository();
    await repo.saveSource(source());
    const handler = createOwnerApiHandler(
      dependencies({ repository: repo, enqueueSource: async () => undefined }),
    );
    const response = await handler(
      new Request("https://fads.cc/api/v1/sources/rss%3Aone/refresh", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "bad-refresh" },
        body: JSON.stringify({ unexpected: true }),
      }),
    );

    expect(response.status).toBe(400);
    expect((await repo.getSource(OWNER, "rss:one"))?.status).toBe("idle");
  });

  it("enqueues refreshes with a claim-derived work identifier", async () => {
    const repo = repository();
    await repo.saveSource(source());
    let workId: string | undefined;
    const handler = createOwnerApiHandler(
      dependencies({
        repository: repo,
        enqueueSource: async (message) => {
          workId = message.workId;
        },
      }),
    );

    const response = await handler(
      new Request("https://fads.cc/api/v1/sources/rss%3Aone/refresh", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "refresh-work" },
        body: "{}",
      }),
    );

    expect(response.status).toBe(202);
    expect(workId).toMatch(/^sync:[0-9a-f-]+$/);
  });
});
