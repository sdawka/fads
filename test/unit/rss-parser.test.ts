import { describe, expect, it } from "vitest";

import { parseFeed } from "../../src/modules/sources/rss";

const capturedAt = "2026-08-28T12:00:00.000Z";

describe("RSS and Atom parsing", () => {
  it("normalizes RSS podcast items with namespace extensions and relative links", () => {
    const feed = parseFeed(
      `<?xml version="1.0"?><rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><title>Signal</title><item><guid isPermaLink="false">opaque-42</guid><title>Hello &amp; goodbye</title><description><![CDATA[<p>One <a href="/essay">essay</a></p>]]></description><link>/posts/1</link><pubDate>Thu, 28 Aug 2026 10:00:00 GMT</pubDate><author>Ada</author><enclosure url="/audio.mp3" type="audio/mpeg"/><itunes:duration>01:02:03</itunes:duration><itunes:image href="/cover.jpg"/></item></channel></rss>`,
      { feedUrl: "https://example.com/feeds/main.xml", sourceId: "rss:signal", capturedAt },
    );

    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]).toMatchObject({
      id: "rss:signal:opaque-42",
      canonicalUri: "https://example.com/posts/1",
      sourceId: "rss:signal",
      publishedAt: "2026-08-28T10:00:00.000Z",
      capturedAt,
      blocks: [
        { kind: "heading", text: "Hello & goodbye", level: 2 },
        { kind: "paragraph", text: "One essay" },
        { kind: "link", href: "https://example.com/essay", text: "essay" },
        { kind: "paragraph", text: "By Ada" },
        { kind: "paragraph", text: "Duration: 01:02:03" },
      ],
      media: [
        expect.objectContaining({ kind: "audio", url: "https://example.com/audio.mp3" }),
        expect.objectContaining({ kind: "image", url: "https://example.com/cover.jpg" }),
      ],
    });
  });

  it("accepts Atom IDs and links without collapsing two opaque IDs with the same title", () => {
    const feed = parseFeed(
      `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><entry><id>tag:example.com,2026:one</id><title>Same title</title><updated>2026-08-28T11:00:00Z</updated><link href="/one"/><content type="html">&lt;p&gt;First&lt;/p&gt;</content></entry><entry><id>tag:example.com,2026:two</id><title>Same title</title><updated>2026-08-28T11:01:00Z</updated><link href="/two"/></entry></feed>`,
      { feedUrl: "https://example.com/atom", sourceId: "rss:atom", capturedAt },
    );

    expect(feed.items.map((item) => item.id)).toEqual([
      "rss:atom:tag:example.com,2026:one",
      "rss:atom:tag:example.com,2026:two",
    ]);
    expect(feed.items.map((item) => item.canonicalUri)).toEqual([
      "https://example.com/one",
      "https://example.com/two",
    ]);
  });

  it("returns no items for malformed XML and ignores duplicate GUIDs", () => {
    expect(
      parseFeed("<rss><channel><item>", {
        feedUrl: "https://example.com/feed",
        sourceId: "rss:x",
        capturedAt,
      }).items,
    ).toEqual([]);
    expect(
      parseFeed(
        `<rss><channel><item><guid>a</guid><title>One</title></item><item><guid>a</guid><title>Two</title></item></channel></rss>`,
        { feedUrl: "https://example.com/feed", sourceId: "rss:x", capturedAt },
      ).items,
    ).toHaveLength(1);
  });

  it("does not turn discarded source markup into a paragraph", () => {
    const feed = parseFeed(
      `<rss><channel><item><guid>unsafe</guid><title>Safe title</title><description><![CDATA[<script>alert(1)</script><style>body{display:none}</style><iframe src="https://evil.example"></iframe>]]></description></item></channel></rss>`,
      { feedUrl: "https://example.com/feed", sourceId: "rss:safe", capturedAt },
    );

    expect(feed.items[0]?.blocks).toEqual([{ kind: "heading", text: "Safe title", level: 2 }]);
  });
});
