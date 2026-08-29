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

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structural validation prevents malformed/private API responses entering the personal cache. */
export function isValidActiveEditionResponse(value: unknown): boolean {
  if (!record(value)) return false;
  const edition = value.edition;
  const content = value.content;
  if (
    !record(edition) ||
    typeof edition.id !== "string" ||
    !edition.id.trim() ||
    !Array.isArray(edition.items) ||
    edition.items.length > 12
  )
    return false;
  if (
    !Array.isArray(content) ||
    content.length > 12 ||
    typeof value.position !== "number" ||
    !Number.isInteger(value.position) ||
    value.position < 0 ||
    value.position > edition.items.length ||
    typeof value.completed !== "boolean"
  )
    return false;
  const contentIds = new Set<string>();
  for (const item of edition.items) {
    if (
      !record(item) ||
      typeof item.contentId !== "string" ||
      !item.contentId.trim() ||
      typeof item.position !== "number" ||
      !Number.isInteger(item.position) ||
      item.position < 0 ||
      item.position >= edition.items.length
    )
      return false;
  }
  for (const item of content) {
    if (
      !record(item) ||
      typeof item.id !== "string" ||
      !item.id.trim() ||
      "html" in item ||
      "raw" in item ||
      "markup" in item
    )
      return false;
    contentIds.add(item.id);
    if ("blocks" in item && !Array.isArray(item.blocks)) return false;
  }
  return edition.items.every((item) =>
    contentIds.has((item as Record<string, unknown>).contentId as string),
  );
}

export function shouldUseOfflineFallback(request: Request): boolean {
  if (request.method !== "GET") return false;
  if (request.mode === "navigate") return true;
  const accept = request.headers.get("accept") ?? "";
  return accept.includes("text/html") && !new URL(request.url).pathname.startsWith("/api/");
}
