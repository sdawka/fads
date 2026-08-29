import {
  OAuthClient,
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

export interface OwnerSessionStore {
  createAppSession(input: {
    tokenHash: string;
    did: string;
    idleExpiresAt: number;
    absoluteExpiresAt: number;
  }): Promise<void>;
  readAppSession(input: { tokenHash: string; now: number }): Promise<{ did: string } | undefined>;
  touchAppSession(input: { tokenHash: string; now: number; idleExpiresAt: number }): Promise<void>;
  deleteAppSession(input: { tokenHash: string }): Promise<void>;
  getOAuthState(input: { key: string }): Promise<unknown>;
  putOAuthState(input: { key: string; value: unknown }): Promise<void>;
  deleteOAuthState(input: { key: string }): Promise<void>;
  getOAuthSession(input: { did: string }): Promise<unknown>;
  putOAuthSession(input: { did: string; value: unknown }): Promise<void>;
  deleteOAuthSession(input: { did: string }): Promise<void>;
  tryAcquireRefreshLock(input: { name: string; holder: string; now: number }): Promise<boolean>;
  renewRefreshLock(input: { name: string; holder: string; now: number }): Promise<boolean>;
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
}

export function createAtprotoAuth(options: AtprotoAuthOptions) {
  const origin = httpsOrigin(options.origin);
  const now = options.now ?? Date.now;
  const metadata = {
    client_id: `${origin}/oauth/client-metadata.json`,
    redirect_uris: [`${origin}/oauth/callback`],
    scope: "atproto transition:generic",
    jwks_uri: `${origin}/oauth/jwks.json`,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "private_key_jwt",
  };
  const requestLock = createDoRequestLock(options.session, now);
  const getOAuth = () =>
    (options.oauthFactory ?? createSdkOAuth)({
      metadata,
      privateJwks: options.privateJwks,
      session: options.session,
      fetch: options.fetch,
      requestLock,
    });

  return {
    clientMetadata: () => metadata,
    jwks: () => ({ keys: options.privateJwks.map(publicJwk) }),
    async start(request: Request): Promise<Response> {
      const handle = new URL(request.url).searchParams.get("handle")?.trim();
      if (!handle) return new Response("Missing AT Protocol handle", { status: 400 });
      const authorization = await getOAuth().authorize({
        target: { type: "account", identifier: handle as ActorIdentifier },
      });
      return Response.redirect(authorization.url, 302);
    },
    async callback(request: Request): Promise<Response> {
      const oauth = getOAuth();
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
      await options.session.createAppSession({
        tokenHash,
        did: options.ownerDid,
        idleExpiresAt: issuedAt + IDLE_MS,
        absoluteExpiresAt: issuedAt + ABSOLUTE_MS,
      });
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
      await options.session.touchAppSession({
        tokenHash,
        now: inspectedAt,
        idleExpiresAt: inspectedAt + IDLE_MS,
      });
      return { did: app.did };
    },
    async restore(request: Request): Promise<OAuthSession | undefined> {
      const app = await this.inspect(request);
      return app ? getOAuth().restore(app.did) : undefined;
    },
    async restoreOwner(): Promise<OAuthSession> {
      return getOAuth().restore(options.ownerDid);
    },
    async logout(request: Request): Promise<Response> {
      const token = readCookie(request.headers.get("cookie"), APP_COOKIE);
      const app = await this.inspect(request);
      if (token)
        await options.session.deleteAppSession({ tokenHash: await hashAppSessionToken(token) });
      if (app)
        await getOAuth()
          .revoke(app.did)
          .catch(() => undefined);
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
        set: (key, value) => input.session.putOAuthState({ key, value }),
        delete: (key) => input.session.deleteOAuthState({ key }),
        clear: () => Promise.resolve(),
      },
      sessions: {
        get: async (did) =>
          (await input.session.getOAuthSession({ did })) as StoredSession | undefined,
        set: (did, value) => input.session.putOAuthSession({ did, value }),
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

function createDoRequestLock(session: OwnerSessionStore, now: () => number) {
  return async function requestLock<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const holder = crypto.randomUUID();
    while (!(await session.tryAcquireRefreshLock({ name, holder, now: now() }))) {
      await new Promise<void>((resolve) => setTimeout(resolve, 15));
    }
    const leaseHeartbeat = setInterval(() => {
      void session.renewRefreshLock({ name, holder, now: now() }).catch(() => undefined);
    }, REFRESH_LEASE_RENEW_MS);
    try {
      return await operation();
    } finally {
      clearInterval(leaseHeartbeat);
      await session.releaseRefreshLock({ name, holder });
    }
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
