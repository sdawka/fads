import type { AuthenticatedOwner } from "./modules/auth";

interface RuntimeAuth {
  clientMetadata(): Record<string, unknown>;
  jwks(): Record<string, unknown>;
  start(request: Request): Promise<Response>;
  callback(request: Request): Promise<Response>;
  inspect(request: Request): Promise<AuthenticatedOwner | undefined>;
}

export type RuntimeApiHandler = (
  request: Request,
  owner: AuthenticatedOwner,
) => Promise<Response | undefined>;

export function createRuntimeRouter(input: { auth: RuntimeAuth; api: RuntimeApiHandler }) {
  return async function route(request: Request): Promise<Response | undefined> {
    const path = new URL(request.url).pathname;

    if (path === "/oauth/client-metadata.json") {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return publicJson(input.auth.clientMetadata());
    }
    if (path === "/oauth/jwks.json") {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return publicJson(input.auth.jwks());
    }
    if (path === "/oauth/start") {
      if (request.method !== "GET") return withPrivateHeaders(methodNotAllowed("GET"));
      return withPrivateHeaders(await input.auth.start(request));
    }
    if (path === "/oauth/callback") {
      if (request.method !== "GET") return withPrivateHeaders(methodNotAllowed("GET"));
      return withPrivateHeaders(await input.auth.callback(request));
    }
    if (!path.startsWith("/api/v1/")) return undefined;

    const owner = await input.auth.inspect(request);
    if (path === "/api/v1/session" && request.method === "GET") {
      return privateJson(
        owner
          ? { authenticated: true, did: owner.did, expiresAt: owner.expiresAt }
          : { authenticated: false },
      );
    }
    if (!owner) {
      return problem(
        401,
        "Authentication required",
        "Sign in as the configured owner to continue.",
      );
    }

    const response = await input.api(request, owner);
    return response
      ? withPrivateHeaders(response)
      : problem(404, "Not found", "The requested private API route does not exist.");
  };
}

function publicJson(value: unknown): Response {
  return Response.json(value, { headers: { "cache-control": "public, max-age=300" } });
}

function privateJson(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("cache-control", "private, no-store");
  return Response.json(value, { ...init, headers });
}

function problem(status: number, title: string, detail: string): Response {
  return privateJson(
    { type: "about:blank", title, status, detail },
    { status, headers: { "content-type": "application/problem+json" } },
  );
}

function methodNotAllowed(allow: string): Response {
  return new Response(null, { status: 405, headers: { allow } });
}

function withPrivateHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "private, no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
