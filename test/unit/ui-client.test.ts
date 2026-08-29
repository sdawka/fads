import { describe, expect, it, vi } from "vitest";

import { createBrowserUiClient } from "../../src/components";

describe("browser UI client", () => {
  it("keeps personalized reads private and validates an active edition", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ authenticated: true, did: "did:plc:owner" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const session = await createBrowserUiClient(fetcher).session();

    expect(session).toEqual({ authenticated: true, did: "did:plc:owner" });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/session",
      expect.objectContaining({ credentials: "same-origin", cache: "no-store" }),
    );
  });

  it("adds an idempotency key to feedback mutations", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          interaction: {
            id: "interaction-1",
            ownerId: "did:plc:owner",
            contentId: "content-1",
            sourceId: "source-1",
            kind: "good_surprise",
            occurredAt: "2026-08-28T12:00:00.000Z",
            provenance: { source: "owner-feedback", observedAt: "2026-08-28T12:00:00.000Z" },
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    await createBrowserUiClient(fetcher).interact({
      editionId: "edition-1",
      contentId: "content-1",
      sourceId: "source-1",
      kind: "good_surprise",
    });

    const init = fetcher.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("Idempotency-Key")).toBeTruthy();
    expect(init?.body).toContain('"kind":"good_surprise"');
  });

  it("uses PATCH for edition progress", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          progress: {
            editionId: "edition-1",
            ownerId: "did:plc:owner",
            position: 3,
            completed: false,
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    await createBrowserUiClient(fetcher).setProgress("edition-1", 3);

    expect(fetcher.mock.calls[0]?.[1]?.method).toBe("PATCH");
  });

  it("accepts the service worker's explicit queued mutation response", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ queued: true }), {
        status: 202,
        headers: { "Content-Type": "application/json", "x-offline-queued": "true" },
      }),
    );

    await expect(
      createBrowserUiClient(fetcher).interact({
        editionId: "edition-1",
        contentId: "content-1",
        sourceId: "source-1",
        kind: "keep",
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects session responses with undeclared fields", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ authenticated: false, did: "did:plc:leak" }), {
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(createBrowserUiClient(fetcher).session()).rejects.toThrow(
      "Invalid session response.",
    );
  });
});
