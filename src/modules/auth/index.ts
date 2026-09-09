import {
  OAuthClient,
  scope as oauthScope,
  type AuthorizationResult,
  type CallbackResult,
  type ClientAssertionPrivateJwk,
  type OAuthSession,
  type StoredSession,
  type StoredState,
} from "@atcute/oauth-node-client";
import {
  CompositeDidDocumentResolver,
  CompositeHandleResolver,
  LocalActorResolver,
  PlcDidDocumentResolver,
  WebDidDocumentResolver,
  WellKnownHandleResolver,
} from "@atcute/identity-resolver";
import type { ActorIdentifier } from "@atcute/lexicons/syntax";

const APP_COOKIE = "fads_session";
const IDLE_MS = 8 * 60 * 60 * 1000;
const ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000;
const REFRESH_LEASE_RENEW_MS = 15_000;
const READ_ONLY_RPC_METHODS = [
  "app.bsky.feed.getTimeline",
  "app.bsky.feed.getFeed",
  "app.bsky.feed.getPosts",
  "app.bsky.graph.getFollows",
  "app.bsky.feed.getActorLikes",
  "app.bsky.graph.getActorStarterPacks",
  "app.bsky.feed.getAuthorFeed",
] as const;

export interface OwnerSessionStore {
  getAuthGeneration(): Promise<number>;
  resetAuthentication(): Promise<number>;
  createAppSession(input: {
    tokenHash: string;
    did: string;
    idleExpiresAt: number;
    absoluteExpiresAt: number;
    generation?: number;
  }): Promise<boolean>;
  readAppSession(input: {
    tokenHash: string;
    now: number;
  }): Promise<{ did: string; absoluteExpiresAt: number; generation: number } | undefined>;
  touchAppSession(input: {
    tokenHash: string;
    now: number;
    idleExpiresAt: number;
    generation?: number;
  }): Promise<boolean>;
  deleteAppSession(input: { tokenHash: string }): Promise<void>;
  deleteAllAppSessions(): Promise<void>;
  getOAuthState(input: { key: string }): Promise<unknown>;
  putOAuthState(input: { key: string; value: unknown; generation?: number }): Promise<boolean>;
  deleteOAuthState(input: { key: string }): Promise<void>;
  tryStartOAuth(input: { now: number; generation?: number }): Promise<boolean>;
  getOAuthSession(input: { did: string }): Promise<unknown>;
  putOAuthSession(input: { did: string; value: unknown; generation?: number }): Promise<boolean>;
  deleteOAuthSession(input: { did: string }): Promise<void>;
  tryAcquireRefreshLock(input: {
    name: string;
    holder: string;
    now: number;
    generation?: number;
  }): Promise<boolean>;
  renewRefreshLock(input: {
    name: string;
    holder: string;
    now: number;
    generation?: number;
  }): Promise<boolean>;
  releaseRefreshLock(input: { name: string; holder: string }): Promise<void>;
}

interface OAuthFlow {
  readonly metadata: Record<string, unknown>;
  authorize(input: {
    target: { type: "account"; identifier: ActorIdentifier };
  }): Promise<AuthorizationResult>;
  callback(params: URLSearchParams): Promise<CallbackResult>;
  restore(did: string): Promise<OAuthSession>;
  revoke(did: string): Promise<void>;
}

export interface AtprotoAuthOptions {
  ownerDid: string;
  origin: string;
  privateJwks: ClientAssertionPrivateJwk[];
  session: OwnerSessionStore;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  oauthFactory?: (input: {
    metadata: Record<string, unknown>;
    privateJwks: ClientAssertionPrivateJwk[];
    session: OwnerSessionStore;
    fetch?: typeof globalThis.fetch;
    requestLock: <T>(name: string, operation: () => Promise<T>) => Promise<T>;
  }) => OAuthFlow;
}

export interface AuthenticatedOwner {
  did: string;
  expiresAt: string;
}

export function createAtprotoAuth(options: AtprotoAuthOptions) {
  const origin = httpsOrigin(options.origin);
  const now = options.now ?? Date.now;
  const metadata = {
    client_id: `${origin}/oauth/client-metadata.json`,
    redirect_uris: [`${origin}/oauth/callback`],
    scope: [
      "atproto",
      oauthScope.rpc({
        lxm: [...READ_ONLY_RPC_METHODS],
        aud: "did:web:api.bsky.app#bsky_appview",
      }),
    ].join(" "),
    dpop_bound_access_tokens: true,
    jwks_uri: `${origin}/oauth/jwks.json`,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "private_key_jwt",
    token_endpoint_auth_signing_alg: "ES256",
  };
  const getOAuth = (generation: number) =>
    (options.oauthFactory ?? createSdkOAuth)({
      metadata,
      privateJwks: options.privateJwks,
      session: bindAuthGeneration(options.session, generation),
      fetch: options.fetch,
      requestLock: createDoRequestLock(options.session, now, generation),
    });

  return {
    clientMetadata: () => metadata,
    jwks: () => ({ keys: options.privateJwks.map(publicJwk) }),
    async withOwnerMutation<T>(operation: () => Promise<T>): Promise<T> {
      const generation = await options.session.getAuthGeneration();
      return createDoRequestLock(options.session, now, generation)("owner-api-mutation", operation);
    },
    async start(): Promise<Response> {
      const generation = await options.session.getAuthGeneration();
      if (!(await options.session.tryStartOAuth({ now: now(), generation }))) {
        return new Response("Too many OAuth attempts", {
          status: 429,
          headers: { "retry-after": "60" },
        });
      }
      const authorization = await getOAuth(generation).authorize({
        target: { type: "account", identifier: options.ownerDid as ActorIdentifier },
      });
      return Response.redirect(authorization.url, 302);
    },
    async callback(request: Request): Promise<Response> {
      const generation = await options.session.getAuthGeneration();
      const oauth = getOAuth(generation);
      let callback: CallbackResult;
      try {
        callback = await oauth.callback(new URL(request.url).searchParams);
      } catch {
        return new Response("Invalid OAuth callback", { status: 400 });
      }
      if (callback.session.did !== options.ownerDid) {
        try {
          await oauth.revoke(callback.session.did);
        } catch {
          // The local SDK session must be removed even when upstream revocation is unavailable.
        } finally {
          await options.session.deleteOAuthSession({ did: callback.session.did });
        }
        return new Response("This application is restricted to its configured owner", {
          status: 403,
        });
      }
      const token = randomToken();
      const tokenHash = await hashAppSessionToken(token);
      const issuedAt = now();
      try {
        const created = await options.session.createAppSession({
          tokenHash,
          did: options.ownerDid,
          idleExpiresAt: issuedAt + IDLE_MS,
          absoluteExpiresAt: issuedAt + ABSOLUTE_MS,
          generation,
        });
        if (!created) throw new Error("Authentication generation changed");
      } catch {
        return new Response("Invalid OAuth callback", { status: 400 });
      }
      return new Response(null, {
        status: 302,
        headers: {
          location: safeReturnTo(callback.state),
          "set-cookie": appCookie(token, ABSOLUTE_MS),
        },
      });
    },
    async inspect(request: Request): Promise<AuthenticatedOwner | undefined> {
      const token = readCookie(request.headers.get("cookie"), APP_COOKIE);
      if (!token) return undefined;
      const tokenHash = await hashAppSessionToken(token);
      const inspectedAt = now();
      const app = await options.session.readAppSession({ tokenHash, now: inspectedAt });
      if (app?.did !== options.ownerDid) return undefined;
      const touched = await options.session.touchAppSession({
        tokenHash,
        now: inspectedAt,
        idleExpiresAt: inspectedAt + IDLE_MS,
        generation: app.generation,
      });
      if (!touched) return undefined;
      return { did: app.did, expiresAt: new Date(app.absoluteExpiresAt).toISOString() };
    },
    async restore(request: Request): Promise<OAuthSession | undefined> {
      const app = await this.inspect(request);
      if (!app) return undefined;
      const generation = await options.session.getAuthGeneration();
      return getOAuth(generation).restore(app.did);
    },
    async restoreOwner(): Promise<OAuthSession> {
      const generation = await options.session.getAuthGeneration();
      return getOAuth(generation).restore(options.ownerDid);
    },
    async logout(
      request: Request,
      logoutOptions: { allSessions?: boolean } = {},
    ): Promise<Response> {
      const token = readCookie(request.headers.get("cookie"), APP_COOKIE);
      const app = await this.inspect(request);
      if (!logoutOptions.allSessions && token)
        await options.session.deleteAppSession({ tokenHash: await hashAppSessionToken(token) });
      if (app) {
        try {
          const generation = await options.session.getAuthGeneration();
          await getOAuth(generation).revoke(app.did);
        } catch {
          // Clearing the local session is mandatory even when the PDS cannot be reached.
        } finally {
          if (!logoutOptions.allSessions) {
            await options.session.deleteOAuthSession({ did: app.did });
          }
        }
      }
      if (logoutOptions.allSessions) await options.session.resetAuthentication();
      return new Response(null, { status: 204, headers: { "set-cookie": clearCookie() } });
    },
  };
}

function createSdkOAuth(input: {
  metadata: Record<string, unknown>;
  privateJwks: ClientAssertionPrivateJwk[];
  session: OwnerSessionStore;
  fetch?: typeof globalThis.fetch;
  requestLock: <T>(name: string, operation: () => Promise<T>) => Promise<T>;
}): OAuthFlow {
  const fetchThis = input.fetch;
  return new OAuthClient({
    metadata: input.metadata as never,
    keyset: input.privateJwks,
    fetch: fetchThis,
    requestLock: input.requestLock,
    stores: {
      states: {
        get: async (key) => (await input.session.getOAuthState({ key })) as StoredState | undefined,
        set: async (key, value) => {
          await input.session.putOAuthState({ key, value });
        },
        delete: (key) => input.session.deleteOAuthState({ key }),
        clear: () => Promise.resolve(),
      },
      sessions: {
        get: async (did) =>
          (await input.session.getOAuthSession({ did })) as StoredSession | undefined,
        set: async (did, value) => {
          await input.session.putOAuthSession({ did, value });
        },
        delete: (did) => input.session.deleteOAuthSession({ did }),
        clear: () => Promise.resolve(),
      },
    },
    actorResolver: new LocalActorResolver({
      handleResolver: new CompositeHandleResolver({
        strategy: "http-first",
        methods: {
          http: new WellKnownHandleResolver({ fetch: fetchThis }),
          dns: {
            resolve: async () => Promise.reject(new Error("DNS handle resolution is disabled")),
          },
        },
      }),
      didDocumentResolver: new CompositeDidDocumentResolver({
        methods: {
          plc: new PlcDidDocumentResolver({ fetch: fetchThis }),
          web: new WebDidDocumentResolver({ fetch: fetchThis }),
        },
      }),
    }),
  });
}

function createDoRequestLock(session: OwnerSessionStore, now: () => number, generation: number) {
  return async function requestLock<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const holder = crypto.randomUUID();
    while (true) {
      if ((await session.getAuthGeneration()) !== generation) {
        throw new Error("Authentication generation changed");
      }
      if (await session.tryAcquireRefreshLock({ name, holder, now: now(), generation })) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 15));
    }
    const leaseHeartbeat = setInterval(() => {
      void session
        .renewRefreshLock({ name, holder, now: now(), generation })
        .catch(() => undefined);
    }, REFRESH_LEASE_RENEW_MS);
    try {
      return await operation();
    } finally {
      clearInterval(leaseHeartbeat);
      await session.releaseRefreshLock({ name, holder });
    }
  };
}

function bindAuthGeneration(session: OwnerSessionStore, generation: number): OwnerSessionStore {
  const requireCurrent = async (operation: Promise<boolean>) => {
    if (!(await operation)) throw new Error("Authentication generation changed");
    return true;
  };
  return {
    getAuthGeneration: () => session.getAuthGeneration(),
    resetAuthentication: () => session.resetAuthentication(),
    createAppSession: (input) => requireCurrent(session.createAppSession({ ...input, generation })),
    readAppSession: (input) => session.readAppSession(input),
    touchAppSession: (input) => session.touchAppSession({ ...input, generation }),
    deleteAppSession: (input) => session.deleteAppSession(input),
    deleteAllAppSessions: () => session.deleteAllAppSessions(),
    getOAuthState: (input) => session.getOAuthState(input),
    putOAuthState: (input) => requireCurrent(session.putOAuthState({ ...input, generation })),
    deleteOAuthState: (input) => session.deleteOAuthState(input),
    tryStartOAuth: (input) => session.tryStartOAuth({ ...input, generation }),
    getOAuthSession: (input) => session.getOAuthSession(input),
    putOAuthSession: (input) => requireCurrent(session.putOAuthSession({ ...input, generation })),
    deleteOAuthSession: (input) => session.deleteOAuthSession(input),
    tryAcquireRefreshLock: (input) => session.tryAcquireRefreshLock({ ...input, generation }),
    renewRefreshLock: (input) => session.renewRefreshLock({ ...input, generation }),
    releaseRefreshLock: (input) => session.releaseRefreshLock(input),
  };
}

function httpsOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) {
    throw new TypeError("OAuth origin must be an HTTPS origin");
  }
  return url.origin;
}

function publicJwk(jwk: ClientAssertionPrivateJwk): Record<string, unknown> {
  const input = jwk as unknown as Record<string, unknown>;
  const common = pickPublic(input, ["kty", "kid", "use", "key_ops", "alg"]);
  if (input.kty === "EC") return { ...common, ...pickPublic(input, ["crv", "x", "y"]) };
  if (input.kty === "OKP") return { ...common, ...pickPublic(input, ["crv", "x"]) };
  if (input.kty === "RSA") return { ...common, ...pickPublic(input, ["n", "e"]) };
  throw new TypeError("Unsupported OAuth client JWK type");
}

function pickPublic(
  input: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    keys.flatMap((key) => (input[key] === undefined ? [] : [[key, input[key]]])),
  );
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString("base64url");
}

async function hashAppSessionToken(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Buffer.from(digest).toString("base64url");
}

function appCookie(token: string, maxAgeMs: number): string {
  return `${APP_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${Math.floor(maxAgeMs / 1000)}`;
}

function clearCookie(): string {
  return `${APP_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

function readCookie(header: string | null, name: string): string | undefined {
  return header
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

function safeReturnTo(value: unknown): string {
  return typeof value === "object" &&
    value !== null &&
    "returnTo" in value &&
    typeof value.returnTo === "string" &&
    value.returnTo.startsWith("/") &&
    !value.returnTo.startsWith("//")
    ? value.returnTo
    : "/";
}
