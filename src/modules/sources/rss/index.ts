import { XMLParser, XMLValidator } from "fast-xml-parser";

import {
  ContentEnvelopeSchema,
  type ContentEnvelope,
  type MediaAttachment,
  type SafeBlock,
  type SourceAdapter,
} from "../../../contracts";
import {
  canonicalizeUrl,
  normalizeContentHtml,
  validatePublicHttpUrl as validatePublicFeedUrl,
} from "../../content";

export { validatePublicFeedUrl };

export interface ParsedFeed {
  title?: string;
  items: ContentEnvelope[];
}

export interface ParseFeedOptions {
  feedUrl: string;
  sourceId: string;
  capturedAt: string;
}

export interface RssSourceAdapterOptions {
  sourceId: string;
  feedUrl: string;
  fetch: typeof globalThis.fetch;
  now?: () => string;
  maxBytes?: number;
  deadlineMs?: number;
  maxRedirects?: number;
}

export interface RssSyncRepository {
  loadCursor(input: { sourceId: string }): Promise<string | undefined>;
  isKnownContent(input: Pick<ContentEnvelope, "id" | "canonicalUri">): Promise<boolean>;
  /** Must atomically persist items and advance the source cursor. */
  commitSync(input: {
    sourceId: string;
    items: ContentEnvelope[];
    nextCursor?: string;
  }): Promise<void>;
}

export interface RssSynchronizerOptions {
  sourceId: string;
  adapter: SourceAdapter;
  repository: RssSyncRepository;
}

type XmlRecord = Record<string, unknown>;

type SyncCursor = { etag?: string; lastModified?: string };

const defaultMaxBytes = 2 * 1024 * 1024;
const defaultDeadlineMs = 10_000;
const defaultMaxRedirects = 5;
const feedContentTypes = new Set([
  "application/rss+xml",
  "application/atom+xml",
  "application/xml",
  "text/xml",
]);

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", trimValues: true });

function arrayOf(value: unknown): unknown[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function record(value: unknown): XmlRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as XmlRecord)
    : undefined;
}

function valueOf(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number")
    return String(value).trim() || undefined;
  const entry = record(value);
  if (!entry) return undefined;
  return valueOf(entry["#text"] ?? entry.__cdata);
}

function local(entry: XmlRecord, name: string): unknown {
  const key = Object.keys(entry).find(
    (candidate) => candidate === name || candidate.endsWith(`:${name}`),
  );
  return key ? entry[key] : undefined;
}

function firstUrl(value: unknown, baseUrl: string): string | undefined {
  const raw = valueOf(value);
  if (!raw) return undefined;
  try {
    return canonicalizeUrl(raw, baseUrl);
  } catch {
    return undefined;
  }
}

function dateOrCaptured(value: unknown, capturedAt: string): string {
  const raw = valueOf(value);
  if (!raw) return capturedAt;
  const date = new Date(raw);
  return Number.isNaN(date.valueOf()) ? capturedAt : date.toISOString();
}

function appendDescription(blocks: SafeBlock[], content: unknown, baseUrl: string): void {
  const description = valueOf(content);
  if (!description) return;
  const normalized = normalizeContentHtml(description, baseUrl);
  blocks.push(...normalized);
}

function media(
  id: string,
  kind: "image" | "audio" | "video",
  url: string,
  sourceId: string,
  capturedAt: string,
  feedUrl: string,
): MediaAttachment {
  return {
    id,
    kind,
    url,
    provenance: { source: sourceId, observedAt: capturedAt, reference: feedUrl },
  };
}

function parseRssItem(entry: XmlRecord, options: ParseFeedOptions): ContentEnvelope {
  const title = valueOf(local(entry, "title"));
  const guid = valueOf(local(entry, "guid"));
  const link = firstUrl(local(entry, "link"), options.feedUrl);
  const identity = guid ?? link ?? `entry-${title ?? "untitled"}`;
  const canonicalUri =
    link ?? `${canonicalizeUrl(options.feedUrl)}#${encodeURIComponent(identity)}`;
  const blocks: SafeBlock[] = title ? [{ kind: "heading", text: title, level: 2 }] : [];
  appendDescription(blocks, local(entry, "content") ?? local(entry, "description"), canonicalUri);
  const author = valueOf(local(entry, "author") ?? local(entry, "creator"));
  if (author) blocks.push({ kind: "paragraph", text: `By ${author}` });
  const duration = valueOf(local(entry, "duration"));
  if (duration) blocks.push({ kind: "paragraph", text: `Duration: ${duration}` });

  const attachments: MediaAttachment[] = [];
  const enclosure = record(local(entry, "enclosure"));
  const enclosureUrl = enclosure ? firstUrl(enclosure["@_url"], options.feedUrl) : undefined;
  if (enclosureUrl) {
    const type = valueOf(enclosure?.["@_type"]);
    attachments.push(
      media(
        `${options.sourceId}:${identity}:enclosure`,
        type?.startsWith("video/") ? "video" : "audio",
        enclosureUrl,
        options.sourceId,
        options.capturedAt,
        options.feedUrl,
      ),
    );
  }
  const artwork = record(local(entry, "image"));
  const artworkUrl = artwork
    ? firstUrl(artwork["@_href"] ?? artwork["@_url"], options.feedUrl)
    : undefined;
  if (artworkUrl)
    attachments.push(
      media(
        `${options.sourceId}:${identity}:artwork`,
        "image",
        artworkUrl,
        options.sourceId,
        options.capturedAt,
        options.feedUrl,
      ),
    );

  return {
    id: `${options.sourceId}:${identity}`,
    canonicalUri,
    sourceId: options.sourceId,
    publishedAt: dateOrCaptured(
      local(entry, "pubDate") ?? local(entry, "published") ?? local(entry, "updated"),
      options.capturedAt,
    ),
    capturedAt: options.capturedAt,
    blocks,
    media: attachments,
    tags: [],
    labels: [],
  };
}

function parseAtomItem(entry: XmlRecord, options: ParseFeedOptions): ContentEnvelope {
  const title = valueOf(local(entry, "title"));
  const id = valueOf(local(entry, "id"));
  const linkNode = arrayOf(local(entry, "link"))
    .map(record)
    .find((item) => item?.["@_rel"] !== "self");
  const link = linkNode ? firstUrl(linkNode["@_href"], options.feedUrl) : undefined;
  const identity = id ?? link ?? `entry-${title ?? "untitled"}`;
  const canonicalUri =
    link ?? `${canonicalizeUrl(options.feedUrl)}#${encodeURIComponent(identity)}`;
  const blocks: SafeBlock[] = title ? [{ kind: "heading", text: title, level: 2 }] : [];
  appendDescription(blocks, local(entry, "content") ?? local(entry, "summary"), canonicalUri);
  const authorRecord = record(local(entry, "author"));
  const author = valueOf(authorRecord ? local(authorRecord, "name") : undefined);
  if (author) blocks.push({ kind: "paragraph", text: `By ${author}` });
  return {
    id: `${options.sourceId}:${identity}`,
    canonicalUri,
    sourceId: options.sourceId,
    publishedAt: dateOrCaptured(
      local(entry, "published") ?? local(entry, "updated"),
      options.capturedAt,
    ),
    capturedAt: options.capturedAt,
    blocks,
    media: [],
    tags: [],
    labels: [],
  };
}

/** Parses only the fetched XML bytes; it never follows content links or assets. */
export function parseFeed(source: string, options: ParseFeedOptions): ParsedFeed {
  if (XMLValidator.validate(source) !== true) return { items: [] };
  const document = record(xml.parse(source));
  if (!document) return { items: [] };
  const rss = record(document.rss);
  const channel = rss ? record(local(rss, "channel")) : undefined;
  const atom = record(document.feed);
  const entries = channel
    ? arrayOf(local(channel, "item")).map(record)
    : atom
      ? arrayOf(local(atom, "entry")).map(record)
      : [];
  const seen = new Set<string>();
  const items = entries.flatMap((entry) => {
    if (!entry) return [];
    const item = channel ? parseRssItem(entry, options) : parseAtomItem(entry, options);
    if (seen.has(item.id)) return [];
    seen.add(item.id);
    return [item];
  });
  return { title: valueOf(channel ? local(channel, "title") : local(atom ?? {}, "title")), items };
}

function cursorFrom(value: string | undefined): SyncCursor {
  if (!value) return {};
  try {
    const candidate = record(JSON.parse(value));
    if (!candidate) return {};
    return {
      ...(typeof candidate.etag === "string" ? { etag: candidate.etag } : {}),
      ...(typeof candidate.lastModified === "string"
        ? { lastModified: candidate.lastModified }
        : {}),
    };
  } catch {
    return {};
  }
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let rejectAbort: () => void = () => undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    rejectAbort = () =>
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new DOMException("Feed deadline exceeded", "AbortError"),
      );
  });
  const abort = () => {
    rejectAbort();
    void reader.cancel();
  };
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      const result = await Promise.race([reader.read(), abortPromise]);
      const { done, value } = result;
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("Feed response exceeded byte ceiling");
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function isRedirect(response: Response): boolean {
  return response.status >= 300 && response.status < 400;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Feed deadline exceeded", "AbortError");
}

async function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortReason(signal));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export function createRssSourceAdapter(options: RssSourceAdapterOptions): SourceAdapter {
  const maxBytes = options.maxBytes ?? defaultMaxBytes;
  const deadlineMs = options.deadlineMs ?? defaultDeadlineMs;
  const maxRedirects = options.maxRedirects ?? defaultMaxRedirects;
  const now = options.now ?? (() => new Date().toISOString());

  return {
    async sync(cursor?: string): Promise<{ items: ContentEnvelope[]; nextCursor?: string }> {
      const validators = cursorFrom(cursor);
      let url = validatePublicFeedUrl(options.feedUrl);
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new DOMException("deadline exceeded", "TimeoutError")),
        deadlineMs,
      );
      try {
        for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
          const headers = new Headers({
            accept:
              "application/rss+xml, application/atom+xml, application/xml, text/xml, text/plain;q=0.5",
          });
          if (validators.etag) headers.set("if-none-match", validators.etag);
          if (validators.lastModified) headers.set("if-modified-since", validators.lastModified);
          const response = await raceWithAbort(
            options.fetch(url, { headers, redirect: "manual", signal: controller.signal }),
            controller.signal,
          );
          if (response.status === 304)
            return { items: [], ...(cursor ? { nextCursor: cursor } : {}) };
          if (isRedirect(response)) {
            const location = response.headers.get("location");
            if (!location) throw new Error("Feed redirect missing location");
            if (redirects === maxRedirects) throw new Error("Feed redirect limit exceeded");
            url = validatePublicFeedUrl(location, url);
            continue;
          }
          if (!response.ok) throw new Error(`Feed fetch failed with ${response.status}`);
          const contentType = response.headers
            .get("content-type")
            ?.split(";", 1)[0]
            ?.trim()
            .toLowerCase();
          if (
            !contentType ||
            (!feedContentTypes.has(contentType) && contentType !== "text/plain")
          ) {
            throw new Error("Feed response has an unsupported content type");
          }
          const body = await readBoundedBody(response, maxBytes, controller.signal);
          if (
            contentType === "text/plain" &&
            !/^\s*(?:<\?xml[^>]*>\s*)?<(?:rss|feed)\b/i.test(body)
          ) {
            throw new Error("Plain-text response is not a feed");
          }
          const next: SyncCursor = {
            ...(response.headers.get("etag") ? { etag: response.headers.get("etag")! } : {}),
            ...(response.headers.get("last-modified")
              ? { lastModified: response.headers.get("last-modified")! }
              : {}),
          };
          return {
            items: parseFeed(body, {
              feedUrl: url,
              sourceId: options.sourceId,
              capturedAt: now(),
            }).items.map((item) => ContentEnvelopeSchema.parse(item)),
            ...(Object.keys(next).length ? { nextCursor: JSON.stringify(next) } : {}),
          };
        }
        throw new Error("Feed redirect limit exceeded");
      } finally {
        clearTimeout(timer);
      }
    },
    hydrate(): Promise<ContentEnvelope> {
      return Promise.reject(new Error("RSS entries are fully hydrated during feed sync"));
    },
  };
}

/** Coordinates adapter cursors with repository-owned atomic persistence. */
export function createRssSynchronizer(options: RssSynchronizerOptions) {
  return {
    async sync(): Promise<{ items: ContentEnvelope[]; nextCursor?: string }> {
      const cursor = await options.repository.loadCursor({ sourceId: options.sourceId });
      const result = await options.adapter.sync(cursor);
      const items: ContentEnvelope[] = [];
      for (const item of result.items) {
        if (
          !(await options.repository.isKnownContent({
            id: item.id,
            canonicalUri: item.canonicalUri,
          }))
        ) {
          items.push(item);
        }
      }
      await options.repository.commitSync({
        sourceId: options.sourceId,
        items,
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
      });
      return { items, ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) };
    },
  };
}
