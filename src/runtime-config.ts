import type { ClientAssertionPrivateJwk } from "@atcute/oauth-node-client";
import { z } from "zod";

const DidSchema = z.string().regex(/^did:(?:plc|web):[A-Za-z0-9._:%-]+$/);
const PrivateJwkSchema = z.discriminatedUnion("kty", [
  z
    .object({
      kty: z.literal("EC"),
      kid: z.string().trim().min(1),
      alg: z.enum(["ES256", "ES384", "ES512"]),
      crv: z.enum(["P-256", "P-384", "P-521"]),
      x: z.string().min(1),
      y: z.string().min(1),
      d: z.string().min(1),
    })
    .loose(),
  z
    .object({
      kty: z.literal("RSA"),
      kid: z.string().trim().min(1),
      alg: z.enum(["PS256", "PS384", "PS512", "RS256", "RS384", "RS512"]),
      n: z.string().min(1),
      e: z.string().min(1),
      d: z.string().min(1),
    })
    .loose(),
]);
const PrivateJwksSchema = z.array(PrivateJwkSchema).min(1).max(4);
const SafetyLabelsSchema = z
  .array(z.string().trim().min(1).max(100))
  .max(128)
  .transform((labels) => [...new Set(labels)]);

export interface RuntimeEnvironment {
  OWNER_DID?: string;
  APP_ORIGIN?: string;
  ATPROTO_OAUTH_PRIVATE_JWKS?: string;
  SAFETY_LABELS_JSON?: string;
}

export interface RuntimeConfig {
  ownerDid: string;
  origin: string;
  privateJwks: ClientAssertionPrivateJwk[];
  safetyLabels: string[];
}

export function loadRuntimeConfig(env: RuntimeEnvironment): RuntimeConfig {
  const ownerDid = DidSchema.safeParse(env.OWNER_DID);
  if (!ownerDid.success) throw new Error("Invalid or missing owner DID configuration");

  const origin = parseHttpsOrigin(env.APP_ORIGIN);
  const privateJwks = parseJson(env.ATPROTO_OAUTH_PRIVATE_JWKS, PrivateJwksSchema);
  if (!privateJwks.success) throw new Error("Invalid or missing OAuth private JWKs configuration");

  const safetyLabels = env.SAFETY_LABELS_JSON
    ? parseJson(env.SAFETY_LABELS_JSON, SafetyLabelsSchema)
    : SafetyLabelsSchema.safeParse([]);
  if (!safetyLabels.success) throw new Error("Invalid safety labels configuration");

  return {
    ownerDid: ownerDid.data,
    origin,
    privateJwks: privateJwks.data as unknown as ClientAssertionPrivateJwk[],
    safetyLabels: safetyLabels.data,
  };
}

function parseHttpsOrigin(value: string | undefined): string {
  try {
    if (!value) throw new TypeError();
    const url = new URL(value);
    if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) {
      throw new TypeError();
    }
    return url.origin;
  } catch {
    throw new Error("Invalid or missing HTTPS origin configuration");
  }
}

function parseJson<T>(
  value: string | undefined,
  schema: z.ZodType<T>,
): { success: true; data: T } | { success: false } {
  try {
    return schema.safeParse(JSON.parse(value ?? ""));
  } catch {
    return { success: false };
  }
}
