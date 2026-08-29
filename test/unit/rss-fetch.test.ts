import { describe, expect, it, vi } from "vitest";

import { ContentEnvelopeSchema, type SourceAdapter } from "../../src/contracts";
import { createRssSourceAdapter, validatePublicFeedUrl } from "../../src/modules/sources/rss";

function chunkedResponse(body: string, headers: HeadersInit, status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of body.match(/.{1,8}/g) ?? []) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status, headers });
}

const rss = "<rss><channel><item><guid>x</guid><title>X</title></item></channel></rss>";

describe("RSS network boundary", () => {
  it("rejects non-public, credentialed, and unsupported feed URLs before fetching", () => {
    for (const input of [
      "ftp://example.com/feed",
      "https://user:pass@example.com/feed",
      "http://127.0.0.1/feed",
      "http://10.0.0.1/feed",
      "http://169.254.1.1/feed",
      "http://192.168.1.1/feed",
      "http://[::1]/feed",
      "http://[fc00::1]/feed",
      "http://localhost/feed",
      "http://localtest.me/feed",
      "http://127.0.0.1.nip.io/feed",
    ]) {
      expect(() => validatePublicFeedUrl(input)).toThrow();
    }
  });

  it("accepts only public-unicast IP literals", () => {
    const rejected = [
      "0.0.0.0",
      "100.64.0.1",
      "192.0.2.1",
      "198.18.0.1",
      "224.0.0.1",
      "::",
      "::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "fc00::1",
      "fe80::1",
      "ff02::1",
      "2001:2::1",
      "2001:db8::1",
    ];

    for (const host of rejected) {
      const urlHost = host.includes(":") ? `[${host}]` : host;
      expect(() => validatePublicFeedUrl(`https://${urlHost}/feed`)).toThrow("public host");
    }
    expect(() => validatePublicFeedUrl("https://2606:4700:4700::1111/feed")).toThrow();
    expect(() => validatePublicFeedUrl("https://[2606:4700:4700::1111]/feed")).not.toThrow();
  });

  it("sends validators, follows only public redirects, streams XML, and returns the next cursor", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: "https://cdn.example/feed.xml" } }),
      )
      .mockResolvedValueOnce(
        chunkedResponse(rss, {
          "content-type": "application/rss+xml",
          etag: '"new"',
          "last-modified": "Thu, 28 Aug 2026 10:00:00 GMT",
        }),
      );
    const adapter = createRssSourceAdapter({
      sourceId: "rss:test",
      feedUrl: "https://example.com/feed",
      fetch,
      now: () => "2026-08-28T12:00:00.000Z",
    });

    const result = await adapter.sync(
      JSON.stringify({ etag: '"old"', lastModified: "Wed, 27 Aug 2026 10:00:00 GMT" }),
    );

    expect(result.items.map((item) => item.id)).toEqual(["rss:test:x"]);
    expect(JSON.parse(result.nextCursor ?? "{}")).toEqual({
      etag: '"new"',
      lastModified: "Thu, 28 Aug 2026 10:00:00 GMT",
    });
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "https://example.com/feed",
      expect.objectContaining({ redirect: "manual" }),
    );
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("if-none-match")).toBe('"old"');
  });

  it("returns no items on 304 without fabricating data", async () => {
    const adapter = createRssSourceAdapter({
      sourceId: "rss:test",
      feedUrl: "https://example.com/feed",
      fetch: vi.fn().mockResolvedValue(new Response(null, { status: 304 })),
      now: () => "2026-08-28T12:00:00.000Z",
    });

    await expect(adapter.sync(JSON.stringify({ etag: '"old"' }))).resolves.toEqual({
      items: [],
      nextCursor: JSON.stringify({ etag: '"old"' }),
    });
  });

  it("returns schema-valid output through the frozen SourceAdapter contract", async () => {
    const validAdapter: SourceAdapter = createRssSourceAdapter({
      sourceId: "rss:contract",
      feedUrl: "https://example.com/feed",
      fetch: vi
        .fn()
        .mockResolvedValue(chunkedResponse(rss, { "content-type": "application/rss+xml" })),
      now: () => "2026-08-28T12:00:00.000Z",
    });
    const valid = await validAdapter.sync();
    expect(valid.items.every((item) => ContentEnvelopeSchema.safeParse(item).success)).toBe(true);

    const adapter: SourceAdapter = createRssSourceAdapter({
      sourceId: "rss:contract",
      feedUrl: "https://example.com/feed",
      fetch: vi
        .fn()
        .mockResolvedValue(chunkedResponse(rss, { "content-type": "application/rss+xml" })),
      now: () => "not-a-timestamp",
    });

    await expect(adapter.sync()).rejects.toThrow();
  });

  it("aborts a slow response body after the deadline", async () => {
    const neverEndingBody = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
    });
    const adapter = createRssSourceAdapter({
      sourceId: "rss:slow",
      feedUrl: "https://example.com/feed",
      fetch: vi
        .fn()
        .mockResolvedValue(
          new Response(neverEndingBody, { headers: { "content-type": "text/xml" } }),
        ),
      deadlineMs: 1,
      now: () => "2026-08-28T12:00:00.000Z",
    });

    await expect(adapter.sync()).rejects.toThrow(/deadline|abort/i);
  }, 250);

  it("aborts fetch acquisition when a fetch implementation ignores the signal", async () => {
    const ignoredSignalFetch = vi.fn(() => new Promise<Response>(() => undefined));
    const adapter = createRssSourceAdapter({
      sourceId: "rss:slow-fetch",
      feedUrl: "https://example.com/feed",
      fetch: ignoredSignalFetch,
      deadlineMs: 1,
      now: () => "2026-08-28T12:00:00.000Z",
    });

    await expect(adapter.sync()).rejects.toThrow(/deadline|abort/i);
  }, 250);

  it("rejects redirect loops, private redirect targets, invalid types, oversized chunks, and deadlines", async () => {
    const loop = createRssSourceAdapter({
      sourceId: "rss:x",
      feedUrl: "https://example.com/a",
      fetch: vi
        .fn()
        .mockResolvedValue(new Response(null, { status: 302, headers: { location: "/a" } })),
      now: () => "2026-08-28T12:00:00.000Z",
    });
    await expect(loop.sync()).rejects.toThrow("redirect");

    const privateHop = createRssSourceAdapter({
      sourceId: "rss:x",
      feedUrl: "https://example.com/a",
      fetch: vi
        .fn()
        .mockResolvedValue(
          new Response(null, { status: 302, headers: { location: "http://127.0.0.1/x" } }),
        ),
      now: () => "2026-08-28T12:00:00.000Z",
    });
    await expect(privateHop.sync()).rejects.toThrow("public");

    const html = createRssSourceAdapter({
      sourceId: "rss:x",
      feedUrl: "https://example.com/a",
      fetch: vi
        .fn()
        .mockResolvedValue(chunkedResponse("<html></html>", { "content-type": "text/html" })),
      now: () => "2026-08-28T12:00:00.000Z",
    });
    await expect(html.sync()).rejects.toThrow("content type");

    const large = createRssSourceAdapter({
      sourceId: "rss:x",
      feedUrl: "https://example.com/a",
      fetch: vi.fn().mockResolvedValue(chunkedResponse(rss, { "content-type": "text/xml" })),
      maxBytes: 20,
      now: () => "2026-08-28T12:00:00.000Z",
    });
    await expect(large.sync()).rejects.toThrow("byte ceiling");

    const slowFetch = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const slow = createRssSourceAdapter({
      sourceId: "rss:x",
      feedUrl: "https://example.com/a",
      fetch: slowFetch,
      deadlineMs: 1,
      now: () => "2026-08-28T12:00:00.000Z",
    });
    await expect(slow.sync()).rejects.toThrow(/abort|deadline/i);
  });
});
