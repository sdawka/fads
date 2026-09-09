import { describe, expect, it } from "vitest";

import {
  discoverManualFeed,
  exportOpml,
  importOpml,
  planSourceSyncs,
} from "../../src/modules/content";

describe("manual subscriptions and queue planning", () => {
  it("discovers a manual feed only after applying the public URL policy", () => {
    expect(discoverManualFeed("https://example.com/feed#section")).toEqual({
      url: "https://example.com/feed",
    });
    expect(() => discoverManualFeed("http://[fe80::1]/feed")).toThrow("public host");
  });

  it("imports bounded OPML through public URL policy and reports rejected candidates", () => {
    const result = importOpml(
      `<?xml version="1.0"?><opml><body><outline text="Signal &amp; Noise" xmlUrl="https://example.com/feed.xml"/><outline text="Local" xmlUrl="http://127.0.0.1/feed"/><outline text="Duplicate" xmlUrl="https://example.com/feed.xml#fragment"/><outline text="No URL"/></body></opml>`,
    );

    expect(result.subscriptions).toEqual([
      { title: "Signal & Noise", url: "https://example.com/feed.xml" },
    ]);
    expect(result.rejected).toEqual([
      { url: "http://127.0.0.1/feed", reason: "Feed URL must target a public host" },
      { url: "", reason: "Missing xmlUrl" },
    ]);
  });

  it("rejects malicious or oversized OPML instead of accepting arbitrary XML", () => {
    expect(() => importOpml("<opml><body><script>alert(1)</script></body></opml>")).toThrow("OPML");
    expect(() => importOpml("x".repeat(64), { maxBytes: 32 })).toThrow("byte ceiling");
  });

  it("exports deterministic escaped OPML that round-trips accepted subscriptions", () => {
    const subscriptions = [
      { title: "Z & Z", url: "https://z.example/feed?x=1&y=2" },
      { title: "A", url: "https://a.example/feed" },
    ];
    const opml = exportOpml(subscriptions);

    expect(opml).toContain('text="A" xmlUrl="https://a.example/feed"');
    expect(opml.indexOf("a.example")).toBeLessThan(opml.indexOf("z.example"));
    expect(opml).toContain("Z &amp; Z");
    expect(importOpml(opml).subscriptions).toEqual([
      { title: "A", url: "https://a.example/feed" },
      { title: "Z & Z", url: "https://z.example/feed?x=1&y=2" },
    ]);
  });

  it("deduplicates equivalent exports deterministically", () => {
    const opml = exportOpml([
      { title: "Z title", url: "https://example.com/feed#one" },
      { title: "A title", url: "https://example.com/feed" },
    ]);

    expect(opml.match(/<outline /g)).toHaveLength(1);
    expect(opml).toContain('text="A title" xmlUrl="https://example.com/feed"');
  });

  it("plans deterministic versioned structured-clone-safe idempotent sync work", () => {
    const work = planSourceSyncs(["rss:z", "rss:a", "rss:z"]);

    expect(work).toEqual([
      {
        message: { version: 1, kind: "sync_source", sourceId: "rss:a" },
        idempotencyKey: "v1:sync_source:rss:a",
      },
      {
        message: { version: 1, kind: "sync_source", sourceId: "rss:z" },
        idempotencyKey: "v1:sync_source:rss:z",
      },
    ]);
    expect(structuredClone(work)).toEqual(work);
  });
});
