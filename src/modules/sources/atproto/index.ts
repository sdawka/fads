import type {
  BootstrapEvidenceProvider,
  ContentEnvelope,
  Evidence,
  SourceAdapter,
} from "../../../contracts";
import { ContentEnvelopeSchema, EvidenceSchema } from "../../../contracts";
import { Client } from "@atcute/client";
import type { OAuthSession } from "@atcute/oauth-node-client";

export interface XrpcResponse {
  ok: boolean;
  data: unknown;
}

export interface AtprotoXrpcClient {
  get(name: string, init?: { params?: Record<string, unknown> }): Promise<XrpcResponse>;
}

export interface AtprotoSourceOptions {
  ownerDid: string;
  client: AtprotoXrpcClient;
  safetyLabels: ReadonlySet<string>;
  sourceId?: string;
  stream?: { kind: "timeline" } | { kind: "feed"; uri: string };
  now?: () => string;
}

export interface SessionBoundAtprotoSourceOptions extends Omit<AtprotoSourceOptions, "client"> {
  session: OAuthSession;
}

export interface AtprotoOmission {
  kind: "omitted";
  reason: "missing" | "deleted" | "blocked" | "muted" | "labelled" | "invalid";
  canonicalUri?: string;
}

export class OmittedAtprotoRecordError extends Error {
  constructor(readonly omission: AtprotoOmission) {
    super(`AT Protocol record omitted: ${omission.reason}`);
  }
}

export function createAtprotoSource(options: AtprotoSourceOptions): SourceAdapter &
  BootstrapEvidenceProvider & {
    tryHydrate(ref: string): Promise<ContentEnvelope | AtprotoOmission>;
  } {
  const sourceId = options.sourceId ?? "atproto";
  const now = options.now ?? (() => new Date().toISOString());

  const tryHydrate = async (ref: string): Promise<ContentEnvelope | AtprotoOmission> => {
    const response = await options.client.get("app.bsky.feed.getPosts", {
      params: { uris: [ref] },
    });
    const posts = response.ok ? object(response.data)?.posts : undefined;
    const post = array(posts)[0];
    return normalizePost(post, {
      sourceId,
      capturedAt: validTimestamp(now()),
      safetyLabels: options.safetyLabels,
    });
  };

  return {
    async hydrate(ref) {
      const result = await tryHydrate(ref);
      if (isOmission(result)) throw new OmittedAtprotoRecordError(result);
      return result;
    },
    async sync(cursor) {
      const stream = options.stream ?? { kind: "timeline" as const };
      if (stream.kind === "feed" && !isCanonicalAtUri(stream.uri)) {
        throw new TypeError("Custom AT Protocol feed must use a canonical AT URI");
      }
      const response = await options.client.get(
        stream.kind === "feed" ? "app.bsky.feed.getFeed" : "app.bsky.feed.getTimeline",
        {
          params:
            stream.kind === "feed"
              ? { feed: stream.uri, cursor, limit: 100 }
              : { cursor, limit: 100 },
        },
      );
      const data = object(response.data);
      const feed = response.ok && Array.isArray(data?.feed) ? data.feed : [];
      const items = feed
        .map((entry) => object(entry)?.post)
        .map((post) =>
          normalizePost(post, {
            sourceId,
            capturedAt: validTimestamp(now()),
            safetyLabels: options.safetyLabels,
          }),
        )
        .filter((entry): entry is ContentEnvelope => !isOmission(entry));
      const nextCursor = string(data?.cursor);
      return nextCursor ? { items, nextCursor } : { items };
    },
    tryHydrate,
    async evidenceFor(ownerId) {
      if (ownerId !== options.ownerDid) return [];
      const [follows, likes, packs, authored] = await Promise.all([
        options.client.get("app.bsky.graph.getFollows", {
          params: { actor: options.ownerDid, limit: 100 },
        }),
        options.client.get("app.bsky.feed.getActorLikes", {
          params: { actor: options.ownerDid, limit: 100 },
        }),
        options.client.get("app.bsky.graph.getActorStarterPacks", {
          params: { actor: options.ownerDid, limit: 100 },
        }),
        options.client.get("app.bsky.feed.getAuthorFeed", {
          params: { actor: options.ownerDid, limit: 100 },
        }),
      ]);
      const observedAt = validTimestamp(now());
      const evidence: Evidence[] = [];
      for (const follow of array(object(follows.data)?.follows)) {
        const did = string(object(follow)?.did);
        if (did) addEvidence(evidence, evidenceFor(sourceId, `at://${did}`, observedAt, "follow"));
      }
      for (const entry of array(object(likes.data)?.feed)) {
        const uri = string(object(object(entry)?.post)?.uri);
        if (isCanonicalAtUri(uri))
          addEvidence(evidence, evidenceFor(sourceId, uri, observedAt, "like"));
      }
      for (const pack of array(object(packs.data)?.starterPacks)) {
        const uri = string(object(pack)?.uri);
        if (isCanonicalAtUri(uri))
          addEvidence(evidence, evidenceFor(sourceId, uri, observedAt, "starter-pack"));
      }
      for (const entry of array(object(authored.data)?.feed)) {
        const uri = string(object(object(entry)?.post)?.uri);
        if (isCanonicalAtUri(uri))
          addEvidence(evidence, evidenceFor(sourceId, uri, observedAt, "authored"));
      }
      return evidence;
    },
  };
}

export function createAtprotoSourceFromSession(options: SessionBoundAtprotoSourceOptions) {
  const client = new Client({
    handler: options.session,
    proxy: "did:web:api.bsky.app#bsky_appview",
  });
  return createAtprotoSource({
    ...options,
    client: {
      get: async (name, init) => client.get(name as never, init as never),
    },
  });
}

function normalizePost(
  input: unknown,
  options: { sourceId: string; capturedAt: string; safetyLabels: ReadonlySet<string> },
): ContentEnvelope | AtprotoOmission {
  const post = object(input);
  if (!post) return { kind: "omitted", reason: "missing" };
  const uri = string(post.uri);
  if (!isCanonicalAtUri(uri)) return { kind: "omitted", reason: "invalid", canonicalUri: uri };
  if (post.notFound === true || post.deleted === true)
    return { kind: "omitted", reason: "deleted", canonicalUri: uri };
  const author = object(post.author);
  const viewer = object(author?.viewer);
  if (post.blocked === true || viewer?.blocking || viewer?.blockedBy) {
    return { kind: "omitted", reason: "blocked", canonicalUri: uri };
  }
  if (viewer?.muted) return { kind: "omitted", reason: "muted", canonicalUri: uri };
  const labels = array(post.labels).flatMap((label) =>
    labelValue(label, options.sourceId, options.capturedAt),
  );
  if (labels.some((label) => options.safetyLabels.has(label.value))) {
    return { kind: "omitted", reason: "labelled", canonicalUri: uri };
  }
  const record = object(post.record);
  const text = string(record?.text) ?? "";
  const blocks = text ? [{ kind: "paragraph" as const, text }] : [];
  const media: ContentEnvelope["media"] = [];
  addEmbed(
    object(post.embed),
    blocks,
    media,
    options.sourceId,
    options.capturedAt,
    options.safetyLabels,
  );
  const candidate = {
    id: uri,
    canonicalUri: uri,
    sourceId: options.sourceId,
    publishedAt: validTimestamp(
      string(record?.createdAt),
      validTimestamp(string(post.indexedAt), options.capturedAt),
    ),
    capturedAt: options.capturedAt,
    blocks,
    media,
    tags: [],
    labels,
  };
  const parsed = ContentEnvelopeSchema.safeParse(candidate);
  return parsed.success ? parsed.data : { kind: "omitted", reason: "invalid", canonicalUri: uri };
}

function addEmbed(
  embed: Record<string, unknown> | undefined,
  blocks: ContentEnvelope["blocks"],
  media: ContentEnvelope["media"],
  sourceId: string,
  observedAt: string,
  safetyLabels: ReadonlySet<string>,
): void {
  if (!embed) return;
  const type = string(embed.$type) ?? "";
  if (type.includes("images")) {
    for (const image of array(embed.images)) addImage(image, media, sourceId, observedAt);
  }
  if (type.includes("video")) {
    const playlist = safeHttpUrl(string(embed.playlist));
    if (playlist)
      media.push({
        id: playlist,
        kind: "video",
        url: playlist,
        provenance: { source: sourceId, observedAt },
      });
  }
  if (type.includes("external")) {
    const external = object(embed.external);
    const uri = safeHttpUrl(string(external?.uri));
    const title = string(external?.title) ?? uri;
    if (uri && title) blocks.push({ kind: "link", href: uri, text: title });
  }
  if (type.includes("record")) {
    const record = object(embed.record);
    const nested = object(record?.record);
    if (!nestedOmitted(nested, safetyLabels)) {
      const value = object(nested?.value);
      const author = object(nested?.author);
      const quoted = string(value?.text);
      if (quoted)
        blocks.push({
          kind: "quote",
          text: quoted,
          attribution: string(author?.displayName) ?? string(author?.handle),
        });
    }
  }
  if (type.includes("recordWithMedia"))
    addEmbed(object(embed.media), blocks, media, sourceId, observedAt, safetyLabels);
}

function addImage(
  input: unknown,
  media: ContentEnvelope["media"],
  sourceId: string,
  observedAt: string,
): void {
  const image = object(input);
  const url = safeHttpUrl(string(image?.fullsize) ?? string(image?.thumb));
  if (!url) return;
  media.push({
    id: url,
    kind: "image",
    url,
    alt: string(image?.alt) ?? "",
    provenance: { source: sourceId, observedAt },
  });
}

function evidenceFor(
  sourceId: string,
  subjectUri: string,
  observedAt: string,
  kind: string,
): Evidence {
  const provenance = isCanonicalAtUri(subjectUri)
    ? { source: sourceId, observedAt, reference: subjectUri }
    : { source: sourceId, observedAt };
  return {
    sourceId,
    subjectUri,
    observedAt,
    tags: [{ value: kind, provenance }],
  };
}

function addEvidence(items: Evidence[], candidate: Evidence): void {
  const parsed = EvidenceSchema.safeParse(candidate);
  if (parsed.success) items.push(parsed.data);
}

function labelValue(
  input: unknown,
  sourceId: string,
  observedAt: string,
): ContentEnvelope["labels"] {
  const label = object(input);
  const value = string(label?.val);
  const reference = safeReference(string(label?.uri));
  return value
    ? [{ value, provenance: { source: sourceId, observedAt, ...(reference ? { reference } : {}) } }]
    : [];
}

function nestedOmitted(
  record: Record<string, unknown> | undefined,
  safetyLabels: ReadonlySet<string>,
): boolean {
  if (!record || record.blocked === true || record.notFound === true || record.deleted === true)
    return true;
  const viewer = object(object(record.author)?.viewer);
  if (viewer?.blocking || viewer?.blockedBy || viewer?.muted) return true;
  return array(record.labels).some((label) => {
    const value = string(object(label)?.val);
    return value !== undefined && safetyLabels.has(value);
  });
}

function validTimestamp(value: string | undefined, fallback = new Date().toISOString()): string {
  if (
    value &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  ) {
    return value;
  }
  return fallback;
}

function safeReference(value: string | undefined): string | undefined {
  return isCanonicalAtUri(value) || safeHttpUrl(value) ? value : undefined;
}

function safeHttpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function isCanonicalAtUri(value: string | undefined): value is string {
  return Boolean(
    value &&
    /^at:\/\/did:[a-z0-9]+:[a-zA-Z0-9._:%-]+\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._~-]+$/.test(value),
  );
}

function isOmission(value: ContentEnvelope | AtprotoOmission): value is AtprotoOmission {
  return "kind" in value && value.kind === "omitted";
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
