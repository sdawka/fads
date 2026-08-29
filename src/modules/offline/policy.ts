import { EditionResponseSchema } from "../../contracts";

/** The only personalized response eligible for the offline cache. */
export const ACTIVE_EDITION_PATH = "/api/v1/editions/active";

/** Keep this list deliberately small: it is the install shell, not a content cache. */
export const STATIC_ASSETS = Object.freeze([
  "/",
  "/offline",
  "/manifest.webmanifest",
  "/icon.svg",
  "/icons/icon-192.svg",
  "/icons/icon-512.svg",
]);

function appOrigin(origin?: string): string {
  if (origin) return origin;
  if (typeof location !== "undefined") return location.origin;
  return "https://fads.cc";
}

export function isCacheableGet(request: Request, origin?: string): boolean {
  const url = new URL(request.url);
  return (
    request.method === "GET" &&
    url.origin === appOrigin(origin) &&
    url.pathname === ACTIVE_EDITION_PATH &&
    url.search === ""
  );
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).every((key) => expected.has(key)) && keys.every((key) => key in value);
}

/** Structural validation prevents malformed/private API responses entering the personal cache. */
export function isValidActiveEditionResponse(value: unknown): boolean {
  const parsed = EditionResponseSchema.safeParse(value);
  if (!parsed.success) return false;
  const response = parsed.data;
  const edition = response.edition;
  const content = response.content;
  if (
    !hasExactKeys(edition, [
      "id",
      "ownerId",
      "createdAt",
      "curiosity",
      "energy",
      "items",
      "decisionTrace",
    ])
  )
    return false;
  if (!Array.isArray(edition.items) || edition.items.length > 12) return false;
  if (
    !Array.isArray(content) ||
    content.length > 12 ||
    !Number.isInteger(response.position) ||
    response.position < 0 ||
    response.position > edition.items.length
  )
    return false;
  const contentIds = new Set<string>();
  const itemIds = new Set<string>();
  const positions = new Set<number>();
  for (const item of edition.items) {
    if (!hasExactKeys(item, ["id", "contentId", "frame", "position", "decisionTrace"]))
      return false;
    if (itemIds.has(item.id) || positions.has(item.position) || item.position !== positions.size)
      return false;
    itemIds.add(item.id);
    positions.add(item.position);
  }
  for (const item of content) {
    if (
      !hasExactKeys(item, [
        "id",
        "canonicalUri",
        "sourceId",
        "publishedAt",
        "capturedAt",
        "blocks",
        "media",
        "tags",
        "labels",
      ])
    )
      return false;
    contentIds.add(item.id);
  }
  return (
    contentIds.size === content.length &&
    edition.items.every((item) => contentIds.has(item.contentId))
  );
}

export function shouldUseOfflineFallback(request: Request): boolean {
  if (request.method !== "GET") return false;
  if (request.mode === "navigate") return true;
  const accept = request.headers.get("accept") ?? "";
  return accept.includes("text/html") && !new URL(request.url).pathname.startsWith("/api/");
}
