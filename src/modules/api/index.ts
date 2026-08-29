import { z } from "zod";

import {
  EditionCreateSchema,
  EditionProgressUpdateSchema,
  IdempotencyKeySchema,
  InterestCreateSchema,
  InteractionCreateSchema,
  KeepCreateSchema,
  OwnerPreferencesSchema,
  ProblemSchema,
  ResetRequestSchema,
  SourceCreateSchema,
  SuggestionDecisionSchema,
  type ContentEnvelope,
  type InteractionEvent,
} from "../../contracts";
import { discoverManualFeed, exportOpml, importOpml } from "../content";
import type { OwnerDataRepository, OwnerSource } from "../storage";

const API_PREFIX = "/api/v1";
const DAY_MS = 24 * 60 * 60 * 1000;
const jsonHeaders = { "content-type": "application/json; charset=utf-8" };
const privateHeaders = { "cache-control": "private, no-store" };

export interface OwnerEditionOperations {
  create(
    request: { ownerId: string; requestedAt: string; curiosity: number; energy: number; limit: number },
    candidates: readonly ContentEnvelope[],
    options: {
      manualInterests: readonly string[];
      blockedLabels: readonly string[];
      mutedSources: readonly string[];
      learnedAdjustments: Readonly<Record<string, number>>;
      notNow: readonly { contentId?: string; canonicalUri?: string; until: string }[];
      recentlyShown: readonly { contentId?: string; canonicalUri?: string; shownAt: string }[];
    },
  ): Promise<{ edition?: unknown; slate?: unknown; selected: readonly ContentEnvelope[] }>;
  resume(ownerId: string, editionId?: string): Promise<unknown>;
  setPosition(ownerId: string, editionId: string, position: number): Promise<unknown>;
  complete(ownerId: string, editionId: string): Promise<unknown>;
}

export interface OwnerApiDependencies {
  ownerDid: string;
  authenticate(request: Request): Promise<{ did: string } | undefined>;
  logout(request: Request): Promise<Response>;
  repository: OwnerDataRepository;
  editions: OwnerEditionOperations;
  enqueueSource?: (message: { version: 1; kind: "sync_source"; ownerId: string; sourceId: string }) => Promise<void>;
  now?: () => string;
  id?: () => string;
}

function withPrivateHeaders(response: Response, replay = false): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", privateHeaders["cache-control"]);
  if (replay) headers.set("idempotent-replay", "true");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function json(value: unknown, status = 200): Response {
  return withPrivateHeaders(new Response(JSON.stringify(value), { status, headers: jsonHeaders }));
}

function problem(status: number, title: string, detail?: string, instance?: string): Response {
  const slug = status === 400 ? "validation" : status === 401 ? "unauthorized" : status === 403 ? "forbidden" : status === 404 ? "not-found" : status === 409 ? "conflict" : status >= 500 ? "upstream" : "request";
  const document = ProblemSchema.parse({
    type: `https://fads.cc/problems/${slug}`,
    title,
    status,
    ...(detail ? { detail } : {}),
    ...(instance ? { instance } : {}),
  });
  return withPrivateHeaders(new Response(JSON.stringify(document), { status, headers: { "content-type": "application/problem+json; charset=utf-8" } }));
}

async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function parseJson<T>(raw: string, schema: z.ZodType<T>): Promise<T> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("INVALID_JSON");
  }
  return schema.parse(value);
}

function sourceId(id: () => string, adapter: string): string {
  const value = id().trim();
  return value.startsWith(`${adapter}:`) ? value : `${adapter}:${value}`;
}

function pathId(pathname: string, base: string): string | undefined {
  const prefix = `${API_PREFIX}/${base}/`;
  if (!pathname.startsWith(prefix)) return undefined;
  const value = pathname.slice(prefix.length).split("/", 1)[0];
  return value ? decodeURIComponent(value) : undefined;
}

/** Framework-independent private API router. The Worker supplies owner authentication. */
export function createOwnerApiHandler(dependencies: OwnerApiDependencies) {
  const now = dependencies.now ?? (() => new Date().toISOString());
  const id = dependencies.id ?? (() => crypto.randomUUID());

  return async function handleOwnerApi(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(API_PREFIX)) return problem(404, "Not found", undefined, url.pathname);

    let owner: { did: string } | undefined;
    try {
      owner = await dependencies.authenticate(request);
    } catch {
      return problem(401, "Authentication required");
    }
    if (url.pathname === `${API_PREFIX}/session` && request.method === "GET") {
      if (!owner) return json({ authenticated: false });
      if (owner.did !== dependencies.ownerDid) return problem(403, "Owner access required");
      return json({ authenticated: true, did: owner.did });
    }
    if (!owner) return problem(401, "Authentication required");
    if (owner.did !== dependencies.ownerDid) return problem(403, "Owner access required");

    const isMutation = !["GET", "HEAD", "OPTIONS"].includes(request.method);
    const raw = isMutation ? await request.text() : "";
    const scope = `${request.method} ${url.pathname}`;
    let idempotency: { key: string; requestHash: string } | undefined;
    if (isMutation) {
      const parsedKey = IdempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
      if (!parsedKey.success) return problem(400, "Invalid request", "A bounded Idempotency-Key is required.");
      const requestHash = await hash(`${scope}\n${raw}`);
      const replay = await dependencies.repository.getIdempotentResponse({ ownerId: owner.did, scope, key: parsedKey.data, requestHash, now: now() });
      if (replay?.conflict) return problem(409, "Idempotency conflict", "The key was already used for another request.");
      if (replay && !replay.conflict) return withPrivateHeaders(replay.response, true);
      idempotency = { key: parsedKey.data, requestHash };
    }

    let response: Response;
    try {
      response = await route({ request, raw, url, ownerId: owner.did, dependencies, now, id });
    } catch (error) {
      if (error instanceof z.ZodError || (error instanceof Error && error.message === "INVALID_JSON")) {
        response = problem(400, "Invalid request", "The request body is invalid.", url.pathname);
      } else if (error instanceof Error && /not found/i.test(error.message)) {
        response = problem(404, "Not found", undefined, url.pathname);
      } else {
        response = problem(502, "Upstream operation failed", "The operation could not be completed.", url.pathname);
      }
    }

    if (idempotency && response.status < 500) {
      const createdAt = now();
      await dependencies.repository.saveIdempotentResponse({ ownerId: owner.did, scope, key: idempotency.key, requestHash: idempotency.requestHash, response: response.clone(), createdAt, expiresAt: new Date(new Date(createdAt).getTime() + DAY_MS).toISOString() });
    }
    return withPrivateHeaders(response);
  };
}

async function route(input: {
  request: Request;
  raw: string;
  url: URL;
  ownerId: string;
  dependencies: OwnerApiDependencies;
  now: () => string;
  id: () => string;
}): Promise<Response> {
  const { request, raw, url, ownerId, dependencies, now, id } = input;
  const repository = dependencies.repository;

  if (url.pathname === `${API_PREFIX}/logout` && request.method === "POST") return dependencies.logout(request);

  if (url.pathname === `${API_PREFIX}/sources` && request.method === "GET") return json({ sources: await repository.listSources(ownerId) });
  if (url.pathname === `${API_PREFIX}/sources` && request.method === "POST") {
    const body = await parseJson(raw, SourceCreateSchema);
    const normalizedUrl = body.url ? discoverManualFeed(body.url).url : undefined;
    const timestamp = now();
    const source: OwnerSource = {
      id: sourceId(id, body.adapter),
      ownerId,
      adapter: body.adapter,
      displayName: body.displayName,
      ...(normalizedUrl ? { url: normalizedUrl } : {}),
      config: body.config,
      status: "idle",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    return json({ source: await repository.saveSource(source) }, 201);
  }
  if (url.pathname === `${API_PREFIX}/sources/opml` && request.method === "POST") {
    const body = await parseJson(raw, z.object({ opml: z.string().min(1).max(2 * 1024 * 1024) }).strict());
    const parsed = importOpml(body.opml);
    const added: OwnerSource[] = [];
    for (const subscription of parsed.subscriptions) {
      const timestamp = now();
      added.push(await repository.saveSource({ id: sourceId(id, "rss"), ownerId, adapter: "rss", displayName: subscription.title || new URL(subscription.url).hostname, url: subscription.url, config: {}, status: "idle", createdAt: timestamp, updatedAt: timestamp }));
    }
    return json({ sources: added, rejected: parsed.rejected }, 201);
  }
  if (url.pathname === `${API_PREFIX}/sources/opml` && request.method === "GET") {
    const sources = (await repository.listSources(ownerId)).filter((source) => source.adapter === "rss" && source.url);
    return withPrivateHeaders(new Response(exportOpml(sources.map((source) => ({ title: source.displayName, url: source.url! }))), { headers: { "content-type": "text/x-opml; charset=utf-8" } }));
  }
  const source = pathId(url.pathname, "sources");
  if (source && decodeURIComponent(url.pathname) === `${API_PREFIX}/sources/${source}` && request.method === "DELETE") {
    return (await repository.removeSource(ownerId, source)) ? new Response(null, { status: 204 }) : problem(404, "Not found");
  }
  if (source && decodeURIComponent(url.pathname) === `${API_PREFIX}/sources/${source}/refresh` && request.method === "POST") {
    const updated = await repository.setSourceStatus(ownerId, source, { status: "queued", updatedAt: now() });
    if (!updated) return problem(404, "Not found");
    await dependencies.enqueueSource?.({ version: 1, kind: "sync_source", ownerId, sourceId: source });
    return json({ source: updated }, 202);
  }

  if (url.pathname === `${API_PREFIX}/interests` && request.method === "GET") return json({ interests: await repository.listInterests(ownerId) });
  if (url.pathname === `${API_PREFIX}/interests` && request.method === "POST") {
    const body = await parseJson(raw, InterestCreateSchema);
    return json({ interest: await repository.saveInterest({ id: id(), ownerId, value: body.value, createdAt: now() }) }, 201);
  }
  const interestId = pathId(url.pathname, "interests");
  if (interestId && request.method === "DELETE") return (await repository.removeInterest(ownerId, interestId)) ? new Response(null, { status: 204 }) : problem(404, "Not found");

  if (url.pathname === `${API_PREFIX}/suggestions` && request.method === "GET") return json({ suggestions: await repository.listSuggestions(ownerId) });
  const suggestionId = pathId(url.pathname, "suggestions");
  if (suggestionId && request.method === "POST") {
    const body = await parseJson(raw, SuggestionDecisionSchema);
    const suggestion = await repository.decideSuggestion(ownerId, suggestionId, body.decision, now());
    return suggestion ? json({ suggestion }) : problem(404, "Not found");
  }

  if (url.pathname === `${API_PREFIX}/preferences` && request.method === "GET") return json({ preferences: await repository.getPreferences(ownerId) });
  if (url.pathname === `${API_PREFIX}/preferences` && request.method === "PUT") return json({ preferences: await repository.savePreferences(ownerId, await parseJson(raw, OwnerPreferencesSchema), now()) });

  if (url.pathname === `${API_PREFIX}/editions` && request.method === "POST") {
    const body = await parseJson(raw, EditionCreateSchema);
    const [candidates, interests, preferences, curation] = await Promise.all([repository.listCandidates(ownerId), repository.listInterests(ownerId), repository.getPreferences(ownerId), repository.getCurationState(ownerId)]);
    const result = await dependencies.editions.create({ ownerId, requestedAt: now(), ...body }, candidates, { manualInterests: interests.map((interest) => interest.value), blockedLabels: preferences.blockedLabels, mutedSources: preferences.mutedSourceIds, ...curation });
    return json({ edition: result.edition ?? result.slate, content: result.selected, position: 0, completed: false }, 201);
  }
  if (url.pathname === `${API_PREFIX}/editions/active` && request.method === "GET") {
    const resumed = await dependencies.editions.resume(ownerId);
    if (!resumed) return problem(404, "Not found");
    const content = await repository.listCandidates(ownerId);
    return json({ ...(resumed as Record<string, unknown>), content });
  }
  const editionId = pathId(url.pathname, "editions");
  if (editionId && decodeURIComponent(url.pathname) === `${API_PREFIX}/editions/${editionId}` && request.method === "GET") {
    const resumed = await dependencies.editions.resume(ownerId, editionId);
    return resumed ? json(resumed) : problem(404, "Not found");
  }
  if (editionId && decodeURIComponent(url.pathname) === `${API_PREFIX}/editions/${editionId}/progress` && request.method === "PATCH") {
    const body = await parseJson(raw, EditionProgressUpdateSchema);
    return json({ progress: await dependencies.editions.setPosition(ownerId, editionId, body.position) });
  }
  if (editionId && decodeURIComponent(url.pathname) === `${API_PREFIX}/editions/${editionId}/complete` && request.method === "POST") return json({ progress: await dependencies.editions.complete(ownerId, editionId) });

  if (url.pathname === `${API_PREFIX}/interactions` && request.method === "POST") {
    const body = await parseJson(raw, InteractionCreateSchema);
    const occurredAt = now();
    const event: InteractionEvent = {
      id: id(),
      ownerId,
      ...(body.contentId ? { contentId: body.contentId } : {}),
      ...(body.sourceId ? { sourceId: body.sourceId } : {}),
      kind: body.kind,
      occurredAt,
      provenance: { source: "owner-feedback", observedAt: occurredAt },
    };
    return json({ interaction: await repository.recordInteraction(event) }, 201);
  }
  if (url.pathname === `${API_PREFIX}/keeps` && request.method === "GET") return json({ keeps: await repository.listKeeps(ownerId) });
  if (url.pathname === `${API_PREFIX}/keeps` && request.method === "POST") {
    const body = await parseJson(raw, KeepCreateSchema);
    return json({ keep: await repository.saveKeep({ ownerId, contentId: body.contentId, keptAt: now() }) }, 201);
  }
  const keepId = pathId(url.pathname, "keeps");
  if (keepId && request.method === "DELETE") return (await repository.removeKeep(ownerId, keepId)) ? new Response(null, { status: 204 }) : problem(404, "Not found");

  if (url.pathname === `${API_PREFIX}/export` && request.method === "GET") return json(await repository.exportOwnerData(ownerId));
  if (url.pathname === `${API_PREFIX}/reset` && request.method === "POST") {
    const body = await parseJson(raw, ResetRequestSchema);
    await repository.resetOwnerData(ownerId, body.full);
    return new Response(null, { status: 204 });
  }
  return problem(404, "Not found", undefined, url.pathname);
}
