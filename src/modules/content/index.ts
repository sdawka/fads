import { parseDocument } from "htmlparser2";
import { ElementType } from "domelementtype";
import type { AnyNode } from "domhandler";
import { XMLParser, XMLValidator } from "fast-xml-parser";

import type { QueueMessage, SafeBlock } from "../../contracts";

const executableSchemes = new Set(["data:", "javascript:", "vbscript:"]);
const ignoredTags = new Set(["script", "style", "iframe", "form", "object", "embed", "svg", "math"]);
const opmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", trimValues: true });

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function safeAbsoluteUrl(value: string | undefined, baseUrl: string): string | undefined {
  if (!value) return undefined;

  try {
    const url = new URL(value, baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (executableSchemes.has(url.protocol)) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function textOf(nodes: AnyNode[]): string {
  return compactText(
    nodes
      .map((node) => {
        if (node.type === ElementType.Text) return node.data;
        if (node.type === ElementType.Tag && !ignoredTags.has(node.name.toLowerCase())) return textOf(node.children);
        return "";
      })
      .join(" "),
  );
}

function toBlocks(nodes: AnyNode[], baseUrl: string): SafeBlock[] {
  const blocks: SafeBlock[] = [];

  for (const node of nodes) {
    if (node.type === ElementType.Text) {
      const text = compactText(node.data);
      if (text) blocks.push({ kind: "paragraph", text });
      continue;
    }
    if (node.type !== ElementType.Tag) continue;

    const tag = node.name.toLowerCase();
    if (ignoredTags.has(tag)) continue;
    const text = textOf(node.children);

    if (/^h[1-6]$/.test(tag) && text) {
      blocks.push({ kind: "heading", text, level: Number(tag.slice(1)) });
      continue;
    }
    if (tag === "blockquote" && text) {
      blocks.push({ kind: "quote", text });
      continue;
    }
    if (tag === "pre" && text) {
      blocks.push({ kind: "code", code: text });
      continue;
    }
    if (tag === "img") {
      const src = safeAbsoluteUrl(node.attribs.src, baseUrl);
      if (src) blocks.push({ kind: "image", src, alt: compactText(node.attribs.alt ?? "") });
      continue;
    }
    if (tag === "audio" || tag === "video") {
      const src = safeAbsoluteUrl(node.attribs.src, baseUrl);
      if (src) blocks.push({ kind: tag, src });
      continue;
    }
    if (tag === "a") {
      const href = safeAbsoluteUrl(node.attribs.href, baseUrl);
      if (href && text) blocks.push({ kind: "link", href, text });
      continue;
    }
    if (tag === "p" || tag === "div" || tag === "li" || tag === "article" || tag === "section") {
      if (text) blocks.push({ kind: "paragraph", text });
      for (const child of node.children) {
        if (child.type === ElementType.Tag && ["a", "img", "audio", "video"].includes(child.name.toLowerCase())) {
          blocks.push(...toBlocks([child], baseUrl));
        }
      }
      continue;
    }
    blocks.push(...toBlocks(node.children, baseUrl));
  }

  return blocks;
}

/** Converts untrusted feed HTML into typed renderable blocks, never source markup. */
export function normalizeContentHtml(value: string | undefined, baseUrl: string): SafeBlock[] {
  if (!value) return [];
  return toBlocks(parseDocument(value, { decodeEntities: true }).children, baseUrl);
}

export function canonicalizeUrl(value: string, baseUrl?: string): string {
  const url = new URL(value, baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Expected an HTTP(S) URL");
  if (url.username || url.password) throw new Error("URL credentials are not allowed");
  url.hash = "";
  return url.toString();
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return (
    a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0) || a >= 224
  );
}

function isPrivateIpv6(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host.includes(":")) return false;
  if (host === "::" || host === "::1" || host.startsWith("fc") || host.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(host) || host.startsWith("ff") || host.startsWith("2001:db8:")) return true;
  const mapped = host.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? isPrivateIpv4(mapped[1]) : false;
}

function isLocalAlias(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const encodedIpv4 = [".nip.io", ".sslip.io"]
    .map((suffix) => (host.endsWith(suffix) ? host.slice(0, -suffix.length) : undefined))
    .find((candidate): candidate is string => candidate !== undefined);
  if (encodedIpv4 && isPrivateIpv4(encodedIpv4)) return true;
  return host === "localhost" || host.endsWith(".localhost") || host === "localhost.localdomain" ||
    host.endsWith(".localhost.localdomain") || host === "localtest.me" || host.endsWith(".localtest.me") ||
    host === "lvh.me" || host.endsWith(".lvh.me") || host.endsWith(".local") || host.endsWith(".internal");
}

/** Syntax-only public URL policy shared by subscription import and feed fetching. */
export function validatePublicHttpUrl(value: string, baseUrl?: string): string {
  const url = new URL(value, baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Feed URL must use HTTP(S)");
  if (url.username || url.password) throw new Error("Feed URL credentials are not allowed");
  if (isLocalAlias(url.hostname) || isPrivateIpv4(url.hostname) || isPrivateIpv6(url.hostname)) {
    throw new Error("Feed URL must target a public host");
  }
  url.hash = "";
  return url.toString();
}

export function discoverManualFeed(value: string): { url: string } {
  return { url: validatePublicHttpUrl(value) };
}

export interface Subscription {
  title: string;
  url: string;
}

export interface OpmlImportResult {
  subscriptions: Subscription[];
  rejected: Array<{ url: string; reason: string }>;
}

function asRecords(value: unknown): Record<string, unknown>[] {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value]).flatMap((item) =>
    typeof item === "object" && item !== null ? [item as Record<string, unknown>] : [],
  );
}

function outlines(value: unknown): Record<string, unknown>[] {
  return asRecords(value).flatMap((outline) => [outline, ...outlines(outline.outline)]);
}

/** Imports OPML outlines only; it does not fetch subscriptions or execute XML content. */
export function importOpml(source: string, options: { maxBytes?: number } = {}): OpmlImportResult {
  const size = new TextEncoder().encode(source).byteLength;
  if (size > (options.maxBytes ?? 1024 * 1024)) throw new Error("OPML exceeded byte ceiling");
  if (XMLValidator.validate(source) !== true || /<(?:script|style|iframe|form|object|embed)\b/i.test(source)) {
    throw new Error("OPML is not safe XML");
  }
  const document = opmlParser.parse(source) as Record<string, unknown>;
  const root = document.opml;
  if (typeof root !== "object" || root === null) throw new Error("OPML root is required");
  const body = (root as Record<string, unknown>).body;
  if (typeof body !== "object" || body === null) throw new Error("OPML body is required");
  const subscriptions: Subscription[] = [];
  const rejected: Array<{ url: string; reason: string }> = [];
  const seen = new Set<string>();
  for (const outline of outlines((body as Record<string, unknown>).outline)) {
    const candidate = typeof outline["@_xmlUrl"] === "string" ? outline["@_xmlUrl"] : "";
    if (!candidate) {
      if (typeof outline["@_text"] === "string" || typeof outline["@_title"] === "string") {
        rejected.push({ url: "", reason: "Missing xmlUrl" });
      }
      continue;
    }
    try {
      const url = validatePublicHttpUrl(candidate);
      if (seen.has(url)) continue;
      seen.add(url);
      const candidateTitle = outline["@_title"] ?? outline["@_text"];
      subscriptions.push({ title: typeof candidateTitle === "string" ? candidateTitle.trim() || url : url, url });
    } catch (error) {
      rejected.push({ url: candidate, reason: error instanceof Error ? error.message : "Invalid feed URL" });
    }
  }
  return { subscriptions, rejected };
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function exportOpml(subscriptions: Subscription[]): string {
  const normalized = subscriptions.map((subscription) => ({
    title: subscription.title.trim() || subscription.url,
    url: validatePublicHttpUrl(subscription.url),
  })).sort((left, right) => left.url.localeCompare(right.url) || left.title.localeCompare(right.title));
  const outlines = normalized.map((subscription) =>
    `    <outline text="${xmlEscape(subscription.title)}" xmlUrl="${xmlEscape(subscription.url)}" />`,
  ).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <body>\n${outlines}\n  </body>\n</opml>\n`;
}

export interface PlannedSyncWork {
  message: Extract<QueueMessage, { kind: "sync_source" }>;
  idempotencyKey: string;
}

export function planSourceSyncs(sourceIds: string[]): PlannedSyncWork[] {
  return [...new Set(sourceIds.map((sourceId) => sourceId.trim()).filter(Boolean))]
    .sort()
    .map((sourceId) => ({
      message: { version: 1, kind: "sync_source", sourceId },
      idempotencyKey: `v1:sync_source:${sourceId}`,
    }));
}
