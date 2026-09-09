import { describe, expect, it, vi } from "vitest";

import type { ContentEnvelope } from "../../src/contracts";
import { createRssSourceAdapter, createRssSynchronizer } from "../../src/modules/sources/rss";

function feed(guid: string): string {
  return `<rss><channel><item><guid>${guid}</guid><title>${guid}</title><link>/one</link></item></channel></rss>`;
}

class InMemorySyncRepository {
  cursor: string | undefined;
  readonly stored: ContentEnvelope[] = [];
  readonly commits: Array<{ items: ContentEnvelope[]; nextCursor?: string }> = [];

  async loadCursor(): Promise<string | undefined> {
    return this.cursor;
  }

  async isKnownContent(input: Pick<ContentEnvelope, "id" | "canonicalUri">): Promise<boolean> {
    return this.stored.some(
      (item) => item.id === input.id || item.canonicalUri === input.canonicalUri,
    );
  }

  async commitSync(input: {
    sourceId: string;
    items: ContentEnvelope[];
    nextCursor?: string;
  }): Promise<void> {
    this.stored.push(...input.items);
    this.cursor = input.nextCursor;
    this.commits.push({ items: input.items, nextCursor: input.nextCursor });
  }
}

describe("RSS repository-facing synchronization", () => {
  it("persists each stable/canonical item once while reusing its saved validators", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(feed("first"), {
          headers: { "content-type": "application/rss+xml", etag: '"v1"' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(feed("renamed-guid"), {
          headers: { "content-type": "application/rss+xml", etag: '"v2"' },
        }),
      );
    const repository = new InMemorySyncRepository();
    const adapter = createRssSourceAdapter({
      sourceId: "rss:stored",
      feedUrl: "https://example.com/feed",
      fetch,
      now: () => "2026-08-28T12:00:00.000Z",
    });
    const synchronizer = createRssSynchronizer({ sourceId: "rss:stored", adapter, repository });

    const first = await synchronizer.sync();
    const second = await synchronizer.sync();

    expect(first.items.map((item) => item.id)).toEqual(["rss:stored:first"]);
    expect(second.items).toEqual([]);
    expect(repository.stored.map((item) => item.id)).toEqual(["rss:stored:first"]);
    expect(repository.commits).toEqual([
      {
        items: [expect.objectContaining({ id: "rss:stored:first" })],
        nextCursor: '{"etag":"\\"v1\\""}',
      },
      { items: [], nextCursor: '{"etag":"\\"v2\\""}' },
    ]);
    expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get("if-none-match")).toBe('"v1"');
  });
});
