import { z } from "zod";

import {
  EditionCreateSchema,
  EditionProgressResponseSchema,
  EditionProgressUpdateSchema,
  EditionResponseSchema,
  IdempotencyKeySchema,
  InterestSuggestionSchema,
  InterestCreateSchema,
  InterestResponseSchema,
  InterestsResponseSchema,
  InteractionCreateSchema,
  InteractionResponseSchema,
  KeepCreateSchema,
  KeepResponseSchema,
  KeepsResponseSchema,
  ManualInterestSchema,
  OpmlImportResponseSchema,
  OwnerExportSchema,
  OwnerPreferencesSchema,
  PreferencesResponseSchema,
  ProblemSchema,
  RecommendationSlateSchema,
  ResetRequestSchema,
  SessionResponseSchema,
  SourceCreateSchema,
  SourceResponseSchema,
  SourcesResponseSchema,
  SuggestionDecisionSchema,
  SuggestionResponseSchema,
  SuggestionsResponseSchema,
  SyncSourceMessageSchema,
  type ContentEnvelope,
  type InteractionEvent,
  type InterestSuggestion,
} from "../../contracts";
import { discoverManualFeed, exportOpml, importOpml } from "../content";
import type { OwnerDataRepository, OwnerSource, OwnerStorageHardeningRepository } from "../storage";

const API_PREFIX = "/api/v1";
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

type ApiRepository = OwnerDataRepository & OwnerStorageHardeningRepository;

export interface OwnerEditionOperations {
  create(
    request: {
      ownerId: string;
      requestedAt: string;
      curiosity: number;
      energy: number;
      limit: number;
    },
    candidates: readonly ContentEnvelope[],
    options: {
      manualInterests: readonly string[];
      confirmedInterests: readonly string[];
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
  repository: ApiRepository;
  editions: OwnerEditionOperations;
  enqueueSource?: (message: ReturnType<typeof SyncSourceMessageSchema.parse>) => Promise<void>;
  now?: () => string;
  id?: () => string;
}

type RouteName =
  | "session"
  | "logout"
  | "sources"
  | "opml"
  | "source"
  | "sourceRefresh"
  | "interests"
  | "interest"
  | "suggestions"
  | "suggestion"
  | "preferences"
  | "editions"
  | "activeEdition"
  | "edition"
  | "editionProgress"
  | "editionComplete"
  | "interactions"
  | "keeps"
  | "keep"
  | "export"
  | "reset";

interface RouteMatch {
  name: RouteName;
  allow: readonly string[];
  id?: string;
}

class RequestFailure extends Error {
  constructor(
    readonly status: number,
    readonly title: string,
    readonly detail?: string,
  ) {
    super(title);
  }
}

class ContractFailure extends Error {}

function withPrivateHeaders(response: Response, replay = false): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "private, no-store");
  if (replay) headers.set("idempotent-replay", "true");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function typedJson<T>(schema: z.ZodType<T>, value: unknown, status = 200): Response {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ContractFailure("Invalid domain response");
  return withPrivateHeaders(
    new Response(JSON.stringify(parsed.data), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    }),
  );
}

/** Validated Worker seam for persisting bootstrap evidence without exposing a private route. */
export async function upsertOwnerBootstrapSuggestions(
  repository: OwnerStorageHardeningRepository,
  ownerId: string,
  input: readonly InterestSuggestion[],
): Promise<InterestSuggestion[]> {
  const suggestions = z.array(InterestSuggestionSchema).parse(input);
  if (suggestions.some((suggestion) => suggestion.ownerId !== ownerId)) {
    throw new Error("Bootstrap suggestion owner mismatch");
  }
  return z
    .array(InterestSuggestionSchema)
    .parse(await repository.upsertBootstrapSuggestions(ownerId, suggestions));
}

function problem(status: number, title: string, detail?: string, instance?: string): Response {
  const slug =
    status === 400
      ? "validation"
      : status === 401
        ? "unauthorized"
        : status === 403
          ? "forbidden"
          : status === 404
            ? "not-found"
            : status === 405
              ? "method-not-allowed"
              : status === 409
                ? "conflict"
                : status === 413
                  ? "content-too-large"
                  : status === 425
                    ? "request-pending"
                    : status >= 500
                      ? "upstream"
                      : "request";
  const document = ProblemSchema.parse({
    type: `https://fads.cc/problems/${slug}`,
    title,
    status,
    ...(detail ? { detail } : {}),
    ...(instance ? { instance } : {}),
  });
  return withPrivateHeaders(
    new Response(JSON.stringify(document), {
      status,
      headers: { "content-type": "application/problem+json; charset=utf-8" },
    }),
  );
}

function methodNotAllowed(match: RouteMatch): Response {
  const response = problem(405, "Method not allowed");
  const headers = new Headers(response.headers);
  headers.set("allow", match.allow.join(", "));
  return new Response(response.body, { status: response.status, headers });
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseJson<T>(raw: string, schema: z.ZodType<T>): T {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new RequestFailure(400, "Invalid request", "The request body is invalid.");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new RequestFailure(400, "Invalid request", "The request body is invalid.");
  }
  return parsed.data;
}

function parseOptionalEmpty(raw: string): void {
  if (!raw) return;
  parseJson(raw, z.object({}).strict());
}

async function readBoundedBody(request: Request): Promise<string> {
  const declared = request.headers.get("content-length");
  if (declared && Number.isFinite(Number(declared)) && Number(declared) > MAX_BODY_BYTES) {
    throw new RequestFailure(413, "Request body too large");
  }
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new RequestFailure(413, "Request body too large");
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(merged);
  } catch {
    throw new RequestFailure(400, "Invalid request", "The request body is not valid UTF-8.");
  }
}

function decodeSegments(pathname: string): string[] | undefined {
  if (!pathname.startsWith(`${API_PREFIX}/`)) return undefined;
  const raw = pathname.slice(API_PREFIX.length + 1).split("/");
  if (!raw.length || raw.some((segment) => !segment)) return undefined;
  try {
    const decoded = raw.map((segment) => decodeURIComponent(segment));
    return decoded.some((segment) => segment.includes("/") || segment.includes("\\"))
      ? undefined
      : decoded;
  } catch {
    return undefined;
  }
}

function matched(name: RouteName, allow: readonly string[], id?: string): RouteMatch {
  return { name, allow, ...(id ? { id } : {}) };
}

function matchRoute(pathname: string): RouteMatch | undefined {
  const parts = decodeSegments(pathname);
  if (!parts) return undefined;
  if (parts.length === 1) {
    switch (parts[0]) {
      case "session":
        return matched("session", ["GET"]);
      case "logout":
        return matched("logout", ["POST"]);
      case "sources":
        return matched("sources", ["GET", "POST"]);
      case "interests":
        return matched("interests", ["GET", "POST"]);
      case "suggestions":
        return matched("suggestions", ["GET"]);
      case "preferences":
        return matched("preferences", ["GET", "PUT"]);
      case "editions":
        return matched("editions", ["POST"]);
      case "interactions":
        return matched("interactions", ["POST"]);
      case "keeps":
        return matched("keeps", ["GET", "POST"]);
      case "export":
        return matched("export", ["GET"]);
      case "reset":
        return matched("reset", ["POST"]);
      default:
        return undefined;
    }
  }
  if (parts.length === 2) {
    if (parts[0] === "sources" && parts[1] === "opml") return matched("opml", ["GET", "POST"]);
    if (parts[0] === "editions" && parts[1] === "active") return matched("activeEdition", ["GET"]);
    if (parts[0] === "sources") return matched("source", ["DELETE"], parts[1]);
    if (parts[0] === "interests") return matched("interest", ["DELETE"], parts[1]);
    if (parts[0] === "suggestions") return matched("suggestion", ["POST"], parts[1]);
    if (parts[0] === "editions") return matched("edition", ["GET"], parts[1]);
    if (parts[0] === "keeps") return matched("keep", ["DELETE"], parts[1]);
    return undefined;
  }
  if (parts.length === 3 && parts[0] === "sources" && parts[2] === "refresh") {
    return matched("sourceRefresh", ["POST"], parts[1]);
  }
  if (parts.length === 3 && parts[0] === "editions") {
    if (parts[2] === "progress") return matched("editionProgress", ["PATCH"], parts[1]);
    if (parts[2] === "complete") return matched("editionComplete", ["POST"], parts[1]);
  }
  return undefined;
}

const ResumeDomainSchema = z
  .object({
    edition: RecommendationSlateSchema,
    position: z.int().min(0).max(12),
    completed: z.boolean(),
    currentItem: z.unknown().optional(),
  })
  .strict();

async function editionResponse(
  repository: ApiRepository,
  ownerId: string,
  editionValue: unknown,
  position: number,
  completed: boolean,
): Promise<Response> {
  const edition = RecommendationSlateSchema.safeParse(editionValue);
  if (!edition.success || edition.data.ownerId !== ownerId) {
    throw new ContractFailure("Invalid edition");
  }
  const ids = edition.data.items.map((item) => item.contentId);
  const content = await repository.hydrateContent(ownerId, ids);
  if (content.length !== ids.length || content.some((item, index) => item.id !== ids[index])) {
    throw new ContractFailure("Edition content could not be hydrated");
  }
  return typedJson(EditionResponseSchema, {
    edition: edition.data,
    content,
    position,
    completed,
  });
}

/** Framework-independent private API router. The Worker supplies owner authentication. */
export function createOwnerApiHandler(dependencies: OwnerApiDependencies) {
  const now = dependencies.now ?? (() => new Date().toISOString());
  return async function handleOwnerApi(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const match = matchRoute(url.pathname);
    if (!match) return problem(404, "Not found", undefined, url.pathname);
    if (!match.allow.includes(request.method)) return methodNotAllowed(match);

    let owner: { did: string } | undefined;
    try {
      owner = await dependencies.authenticate(request);
    } catch {
      return problem(401, "Authentication required");
    }
    if (match.name === "session") {
      if (!owner) return typedJson(SessionResponseSchema, { authenticated: false });
      if (owner.did !== dependencies.ownerDid) return problem(403, "Owner access required");
      return typedJson(SessionResponseSchema, { authenticated: true, did: owner.did });
    }
    if (!owner) return problem(401, "Authentication required");
    if (owner.did !== dependencies.ownerDid) return problem(403, "Owner access required");

    const isMutation = request.method !== "GET";
    let raw = "";
    let idempotency:
      { key: string; requestHash: string; claimToken: string; claimedAt: string } | undefined;
    let mutationSeed = "";
    try {
      if (isMutation) {
        raw = await readBoundedBody(request);
        const parsedKey = IdempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
        if (!parsedKey.success) {
          return problem(400, "Invalid request", "A bounded Idempotency-Key is required.");
        }
        const scope = `${request.method} ${url.pathname}`;
        const requestHash = await digest(`${scope}\n${raw}`);
        const claimedAt = now();
        const expiresAt = new Date(new Date(claimedAt).getTime() + DAY_MS).toISOString();
        const claim = await dependencies.repository.claimIdempotency({
          ownerId: owner.did,
          scope,
          key: parsedKey.data,
          requestHash,
          now: claimedAt,
          expiresAt,
          claimToken: crypto.randomUUID(),
        });
        if (claim.status === "conflict") {
          return problem(
            409,
            "Idempotency conflict",
            "The key was already used for another request.",
          );
        }
        if (claim.status === "pending") {
          return problem(
            425,
            "Request is already pending",
            "Retry after the in-flight request completes.",
          );
        }
        if (claim.status === "completed") return withPrivateHeaders(claim.response, true);
        idempotency = {
          key: parsedKey.data,
          requestHash,
          claimToken: claim.claimToken,
          claimedAt,
        };
        mutationSeed = await digest(`${owner.did}\n${scope}\n${parsedKey.data}\n${requestHash}`);
      }
    } catch (error) {
      if (error instanceof RequestFailure) {
        return problem(error.status, error.title, error.detail, url.pathname);
      }
      return problem(
        502,
        "Upstream operation failed",
        "The operation could not be completed.",
        url.pathname,
      );
    }

    let response: Response;
    try {
      response = await route({
        request,
        raw,
        match,
        ownerId: owner.did,
        dependencies,
        timestamp: idempotency?.claimedAt ?? now(),
        mutationSeed,
        mutationClaimToken: idempotency?.claimToken ?? "",
        idempotencySelector: idempotency
          ? { scope: `${request.method} ${url.pathname}`, key: idempotency.key }
          : undefined,
      });
    } catch (error) {
      if (error instanceof RequestFailure) {
        response = problem(error.status, error.title, error.detail, url.pathname);
      } else if (error instanceof ContractFailure) {
        response = problem(
          502,
          "Upstream operation failed",
          "The operation returned invalid data.",
          url.pathname,
        );
      } else if (error instanceof z.ZodError) {
        response = problem(400, "Invalid request", "The request body is invalid.", url.pathname);
      } else if (error instanceof Error && /not found/i.test(error.message)) {
        response = problem(404, "Not found", undefined, url.pathname);
      } else {
        response = problem(
          502,
          "Upstream operation failed",
          "The operation could not be completed.",
          url.pathname,
        );
      }
    }

    if (idempotency && response.status < 500) {
      try {
        const completed = await dependencies.repository.completeIdempotency({
          ownerId: owner.did,
          scope: `${request.method} ${url.pathname}`,
          key: idempotency.key,
          requestHash: idempotency.requestHash,
          claimToken: idempotency.claimToken,
          response: response.clone(),
          completedAt: now(),
        });
        if (!completed) {
          return problem(
            502,
            "Upstream operation failed",
            "The request result could not be finalized.",
            url.pathname,
          );
        }
      } catch {
        return problem(
          502,
          "Upstream operation failed",
          "The request result could not be finalized.",
          url.pathname,
        );
      }
    }
    return withPrivateHeaders(response);
  };
}

async function route(input: {
  request: Request;
  raw: string;
  match: RouteMatch;
  ownerId: string;
  dependencies: OwnerApiDependencies;
  timestamp: string;
  mutationSeed: string;
  mutationClaimToken: string;
  idempotencySelector?: { scope: string; key: string };
}): Promise<Response> {
  const {
    request,
    raw,
    match,
    ownerId,
    dependencies,
    timestamp,
    mutationSeed,
    mutationClaimToken,
    idempotencySelector,
  } = input;
  const repository = dependencies.repository;
  const stableId = (namespace: string, index = 0) =>
    `${namespace}:${mutationSeed.slice(0, 24)}${index ? `:${index}` : ""}`;

  if (match.name === "logout") {
    parseOptionalEmpty(raw);
    const result = await dependencies.logout(request);
    if (result.status !== 204) throw new ContractFailure("Invalid logout response");
    return withPrivateHeaders(new Response(null, { status: 204 }));
  }

  if (match.name === "sources" && request.method === "GET") {
    return typedJson(SourcesResponseSchema, { sources: await repository.listSources(ownerId) });
  }
  if (match.name === "sources") {
    const body = parseJson(raw, SourceCreateSchema);
    const normalizedUrl = body.url ? discoverManualFeed(body.url).url : undefined;
    const source: OwnerSource = {
      id: stableId(body.adapter),
      ownerId,
      adapter: body.adapter,
      displayName: body.displayName,
      ...(normalizedUrl ? { url: normalizedUrl } : {}),
      config: body.config,
      status: "idle",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    return typedJson(SourceResponseSchema, { source: await repository.saveSource(source) }, 201);
  }

  if (match.name === "opml" && request.method === "GET") {
    const sources = (await repository.listSources(ownerId)).filter(
      (source) => source.adapter === "rss" && source.url,
    );
    const document = exportOpml(
      sources.map((source) => ({ title: source.displayName, url: source.url! })),
    );
    const validated = z.string().min(1).max(MAX_BODY_BYTES).safeParse(document);
    if (!validated.success) throw new ContractFailure("Invalid OPML response");
    return withPrivateHeaders(
      new Response(validated.data, { headers: { "content-type": "text/x-opml; charset=utf-8" } }),
    );
  }
  if (match.name === "opml") {
    const body = parseJson(raw, z.object({ opml: z.string().min(1).max(MAX_BODY_BYTES) }).strict());
    const parsed = importOpml(body.opml);
    const pending: OwnerSource[] = parsed.subscriptions.map((subscription, index) => ({
      id: stableId("rss", index),
      ownerId,
      adapter: "rss",
      displayName: subscription.title || new URL(subscription.url).hostname,
      url: subscription.url,
      config: {},
      status: "idle",
      createdAt: timestamp,
      updatedAt: timestamp,
    }));
    const imported = await repository.importSourcesAtomically(ownerId, pending);
    return typedJson(
      OpmlImportResponseSchema,
      {
        sources: imported.inserted,
        rejected: [
          ...parsed.rejected,
          ...imported.duplicates.map((duplicate) => ({
            url: duplicate.url,
            reason: `duplicate:${duplicate.reason}`,
          })),
        ],
      },
      201,
    );
  }
  if (match.name === "source") {
    parseOptionalEmpty(raw);
    return (await repository.removeSource(ownerId, match.id!))
      ? withPrivateHeaders(new Response(null, { status: 204 }))
      : problem(404, "Not found");
  }
  if (match.name === "sourceRefresh") {
    parseOptionalEmpty(raw);
    if (!dependencies.enqueueSource) throw new ContractFailure("Queue unavailable");
    const existing = await repository.getSource(ownerId, match.id!);
    if (!existing) return problem(404, "Not found");
    await dependencies.enqueueSource({
      version: 1,
      kind: "sync_source",
      ownerId,
      sourceId: match.id!,
      workId: `sync:${mutationClaimToken}`,
    });
    const updated = await repository.setSourceStatus(ownerId, match.id!, {
      status: "queued",
      updatedAt: timestamp,
    });
    if (!updated) throw new ContractFailure("Source disappeared after queueing");
    return typedJson(SourceResponseSchema, { source: updated }, 202);
  }

  if (match.name === "interests" && request.method === "GET") {
    return typedJson(InterestsResponseSchema, {
      interests: await repository.listInterests(ownerId),
    });
  }
  if (match.name === "interests") {
    const body = parseJson(raw, InterestCreateSchema);
    const interest = ManualInterestSchema.parse({
      id: stableId("interest"),
      ownerId,
      value: body.value,
      createdAt: timestamp,
    });
    return typedJson(
      InterestResponseSchema,
      { interest: await repository.saveInterest(interest) },
      201,
    );
  }
  if (match.name === "interest") {
    parseOptionalEmpty(raw);
    return (await repository.removeInterest(ownerId, match.id!))
      ? withPrivateHeaders(new Response(null, { status: 204 }))
      : problem(404, "Not found");
  }

  if (match.name === "suggestions") {
    return typedJson(SuggestionsResponseSchema, {
      suggestions: await repository.listSuggestions(ownerId),
    });
  }
  if (match.name === "suggestion") {
    const body = parseJson(raw, SuggestionDecisionSchema);
    const suggestion = await repository.decideSuggestion(
      ownerId,
      match.id!,
      body.decision,
      timestamp,
    );
    return suggestion
      ? typedJson(SuggestionResponseSchema, { suggestion })
      : problem(404, "Not found");
  }

  if (match.name === "preferences" && request.method === "GET") {
    return typedJson(PreferencesResponseSchema, {
      preferences: await repository.getPreferences(ownerId),
    });
  }
  if (match.name === "preferences") {
    const preferences = parseJson(raw, OwnerPreferencesSchema);
    return typedJson(PreferencesResponseSchema, {
      preferences: await repository.savePreferences(ownerId, preferences, timestamp),
    });
  }

  if (match.name === "editions") {
    const body = parseJson(raw, EditionCreateSchema);
    const [candidates, interests, confirmedInterests, preferences, curation] = await Promise.all([
      repository.listCandidates(ownerId),
      repository.listInterests(ownerId),
      repository.listConfirmedSuggestions(ownerId),
      repository.getPreferences(ownerId),
      repository.getCurationState(ownerId),
    ]);
    const result = await dependencies.editions.create(
      { ownerId, requestedAt: timestamp, ...body },
      candidates,
      {
        manualInterests: interests.map((interest) => interest.value),
        confirmedInterests,
        blockedLabels: preferences.blockedLabels,
        mutedSources: preferences.mutedSourceIds,
        ...curation,
      },
    );
    const response = await editionResponse(
      repository,
      ownerId,
      result.edition ?? result.slate,
      0,
      false,
    );
    return new Response(response.body, { status: 201, headers: response.headers });
  }
  if (match.name === "activeEdition" || match.name === "edition") {
    const resumed = await dependencies.editions.resume(
      ownerId,
      match.name === "edition" ? match.id : undefined,
    );
    if (!resumed) return problem(404, "Not found");
    const parsed = ResumeDomainSchema.safeParse(resumed);
    if (!parsed.success) throw new ContractFailure("Invalid resumed edition");
    return editionResponse(
      repository,
      ownerId,
      parsed.data.edition,
      parsed.data.position,
      parsed.data.completed,
    );
  }
  if (match.name === "editionProgress") {
    const body = parseJson(raw, EditionProgressUpdateSchema);
    return typedJson(EditionProgressResponseSchema, {
      progress: await dependencies.editions.setPosition(ownerId, match.id!, body.position),
    });
  }
  if (match.name === "editionComplete") {
    parseOptionalEmpty(raw);
    return typedJson(EditionProgressResponseSchema, {
      progress: await dependencies.editions.complete(ownerId, match.id!),
    });
  }

  if (match.name === "interactions") {
    const body = parseJson(raw, InteractionCreateSchema);
    let contentContext: Awaited<ReturnType<ApiRepository["getContentContext"]>> | undefined;
    if (body.contentId) {
      contentContext = await repository.getContentContext(ownerId, body.contentId);
      if (!contentContext) throw new RequestFailure(404, "Not found");
      if (!body.editionId) throw new RequestFailure(400, "Invalid request");
      if (
        !(await repository.validateEditionContentMembership(
          ownerId,
          body.editionId,
          body.contentId,
        ))
      ) {
        throw new RequestFailure(409, "Edition content mismatch");
      }
      if (body.sourceId && body.sourceId !== contentContext.sourceId) {
        throw new RequestFailure(
          400,
          "Invalid request",
          "The content does not belong to that source.",
        );
      }
    }
    const derivedSourceId = contentContext?.sourceId ?? body.sourceId;
    if (!derivedSourceId || !(await repository.getSource(ownerId, derivedSourceId))) {
      throw new RequestFailure(404, "Not found");
    }
    const event: InteractionEvent = {
      id: stableId("interaction"),
      ownerId,
      ...(body.contentId ? { contentId: body.contentId } : {}),
      sourceId: derivedSourceId,
      kind: body.kind,
      occurredAt: timestamp,
      provenance: {
        source: `owner-feedback:${contentContext?.format ?? "source"}`,
        observedAt: timestamp,
        ...(contentContext?.canonicalUri.startsWith("http") ||
        contentContext?.canonicalUri.startsWith("at://")
          ? { reference: contentContext.canonicalUri }
          : {}),
      },
    };
    return typedJson(
      InteractionResponseSchema,
      { interaction: await repository.recordInteraction(event) },
      201,
    );
  }

  if (match.name === "keeps" && request.method === "GET") {
    const keeps = await repository.listKeeps(ownerId);
    const content: ContentEnvelope[] = [];
    for (let index = 0; index < keeps.length; index += 12) {
      content.push(
        ...(await repository.hydrateContent(
          ownerId,
          keeps.slice(index, index + 12).map((keep) => keep.contentId),
        )),
      );
    }
    return typedJson(KeepsResponseSchema, { keeps, content });
  }
  if (match.name === "keeps") {
    const body = parseJson(raw, KeepCreateSchema);
    if (!(await repository.getContentContext(ownerId, body.contentId))) {
      throw new RequestFailure(404, "Not found");
    }
    return typedJson(
      KeepResponseSchema,
      {
        keep: await repository.saveKeep({ ownerId, contentId: body.contentId, keptAt: timestamp }),
      },
      201,
    );
  }
  if (match.name === "keep") {
    parseOptionalEmpty(raw);
    return (await repository.removeKeep(ownerId, match.id!))
      ? withPrivateHeaders(new Response(null, { status: 204 }))
      : problem(404, "Not found");
  }

  if (match.name === "export") {
    return typedJson(OwnerExportSchema, await repository.exportOwnerData(ownerId));
  }
  if (match.name === "reset") {
    const body = parseJson(raw, ResetRequestSchema);
    await repository.resetOwnerData(
      ownerId,
      body.full,
      body.full ? idempotencySelector : undefined,
    );
    return withPrivateHeaders(new Response(null, { status: 204 }));
  }
  throw new ContractFailure("Unhandled API route");
}
