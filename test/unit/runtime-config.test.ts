import { describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../../src/runtime-config";

const privateKey = {
  kty: "EC",
  kid: "owner-key",
  alg: "ES256",
  crv: "P-256",
  x: "public-x",
  y: "public-y",
  d: "private-d",
};

function validEnv() {
  return {
    OWNER_DID: "did:plc:owner123",
    APP_ORIGIN: "https://fads.cc",
    ATPROTO_OAUTH_PRIVATE_JWKS: JSON.stringify([privateKey]),
    SAFETY_LABELS_JSON: JSON.stringify(["porn", "graphic-media"]),
  };
}

describe("runtime configuration", () => {
  it("loads a bounded owner-only production configuration", () => {
    expect(loadRuntimeConfig(validEnv())).toEqual({
      ownerDid: "did:plc:owner123",
      origin: "https://fads.cc",
      privateJwks: [privateKey],
      safetyLabels: ["porn", "graphic-media"],
    });
  });

  it.each([
    [{ ...validEnv(), OWNER_DID: "" }, "owner DID"],
    [{ ...validEnv(), OWNER_DID: "alice.test" }, "owner DID"],
    [{ ...validEnv(), APP_ORIGIN: "http://fads.cc" }, "HTTPS origin"],
    [{ ...validEnv(), APP_ORIGIN: "https://fads.cc/app" }, "HTTPS origin"],
    [{ ...validEnv(), ATPROTO_OAUTH_PRIVATE_JWKS: "not json" }, "OAuth private JWKs"],
    [
      { ...validEnv(), ATPROTO_OAUTH_PRIVATE_JWKS: JSON.stringify([{ ...privateKey, d: undefined }]) },
      "OAuth private JWKs",
    ],
    [{ ...validEnv(), SAFETY_LABELS_JSON: JSON.stringify([""]) }, "safety labels"],
  ])("fails closed without disclosing secrets", (env, expectedMessage) => {
    let thrown: unknown;
    try {
      loadRuntimeConfig(env);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain(expectedMessage);
    expect((thrown as Error).message).not.toContain("private-d");
  });

  it("defaults the optional deny-label list to empty", () => {
    const env = validEnv();
    delete (env as Partial<typeof env>).SAFETY_LABELS_JSON;

    expect(loadRuntimeConfig(env).safetyLabels).toEqual([]);
  });
});
