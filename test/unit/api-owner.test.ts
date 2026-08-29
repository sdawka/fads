import { describe, expect, it } from "vitest";

import {
  IdempotencyKeySchema,
  ProblemSchema,
  SourceCreateSchema,
} from "../../src/contracts/api";
import { createOwnerApiHandler, type OwnerApiDependencies } from "../../src/modules/api";
import type { OwnerDataRepository, OwnerSource } from "../../src/modules/storage";

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

function repository(): OwnerDataRepository {
  const sources = new Map<string, OwnerSource>();
  const idempotency = new Map<string, { requestHash: string; response: Response }>();
  return {
    listSources: async (ownerId) => [...sources.values()].filter((item) => item.ownerId === ownerId),
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
    exportOwnerData: async (ownerId) => ({ ownerId, exportedAt: "2026-08-28T12:00:00.000Z", data: {} }),
    resetOwnerData: async () => undefined,
    getIdempotentResponse: async (input) => {
      const record = idempotency.get(`${input.ownerId}:${input.scope}:${input.key}`);
      if (!record) return undefined;
      if (record.requestHash !== input.requestHash) return { conflict: true as const };
      return { conflict: false as const, response: record.response.clone() };
    },
    saveIdempotentResponse: async (input) => {
      idempotency.set(`${input.ownerId}:${input.scope}:${input.key}`, {
        requestHash: input.requestHash,
        response: input.response.clone(),
      });
    },
  };
}

function dependencies(overrides: Partial<OwnerApiDependencies> = {}): OwnerApiDependencies {
  return {
    ownerDid: "did:plc:owner",
    authenticate: async () => ({ did: "did:plc:owner" }),
    logout: async () => new Response(null, { status: 204 }),
    repository: repository(),
    editions: {
      create: async () => ({ edition: undefined, selected: [] }),
      resume: async () => undefined,
      setPosition: async () => undefined,
      complete: async () => undefined,
    },
    now: () => "2026-08-28T12:00:00.000Z",
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
    expect(() => ProblemSchema.parse({ type: "x", title: "x", status: 400, secret: "no" })).toThrow();
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
            return { edition: { id: "edition:one", items: [] }, position: 0, completed: false };
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
});
