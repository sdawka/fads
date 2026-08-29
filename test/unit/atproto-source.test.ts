import { describe, expect, it } from "vitest";
import {
  createAtprotoSource,
  createAtprotoSourceFromSession,
} from "../../src/modules/sources/atproto";
import { ContentEnvelopeSchema, EvidenceSchema } from "../../src/contracts";

const ownerDid = "did:plc:owner123";
const postUri = "at://did:plc:author123/app.bsky.feed.post/3kexample";

const fullPost = {
  $type: "app.bsky.feed.defs#postView",
  uri: postUri,
  cid: "bafyreiboguspostcid",
  indexedAt: "2026-08-28T12:00:00.000Z",
  record: {
    $type: "app.bsky.feed.post",
    text: "A thoughtful post with a https://unsafe.example facet",
    createdAt: "2026-08-28T11:59:00.000Z",
    facets: [
      {
        index: { byteStart: 25, byteEnd: 47 },
        features: [{ $type: "app.bsky.richtext.facet#link", uri: "javascript:alert(1)" }],
      },
    ],
  },
  author: { did: "did:plc:author123", handle: "renamed.example", displayName: "Author" },
  labels: [
    { src: "did:plc:labeler", uri: postUri, val: "sexual", cts: "2026-08-28T12:00:00.000Z" },
  ],
  embed: {
    $type: "app.bsky.embed.recordWithMedia#view",
    media: {
      $type: "app.bsky.embed.images#view",
      images: [
        {
          thumb: "https://cdn.example/thumb.jpg",
          fullsize: "https://cdn.example/full.jpg",
          alt: "Garden sketch",
          aspectRatio: { width: 4, height: 3 },
        },
      ],
    },
    record: {
      $type: "app.bsky.embed.record#view",
      record: {
        $type: "app.bsky.embed.record#viewRecord",
        uri: "at://did:plc:quoted123/app.bsky.feed.post/3kquoted",
        cid: "bafyquoted",
        value: {
          $type: "app.bsky.feed.post",
          text: "Quoted material",
          createdAt: "2026-08-28T10:00:00.000Z",
        },
        author: { did: "did:plc:quoted123", handle: "quoted.example", displayName: "Quoted" },
        labels: [],
      },
    },
  },
};

describe("AT Protocol source adapter", () => {
  it("syncs the owner's home timeline for consumption by default", async () => {
    const calls: Array<{ name: string; params?: Record<string, unknown> }> = [];
    const source = createAtprotoSource({
      ownerDid,
      client: {
        get: async (name, init) => {
          calls.push({ name, params: init?.params });
          return { ok: true, data: { feed: [{ post: fullPost }], cursor: "next-page" } };
        },
      },
      safetyLabels: new Set(),
      now: () => "2026-08-28T12:05:00.000Z",
    });

    const result = await source.sync("previous-page");

    expect(calls).toEqual([
      {
        name: "app.bsky.feed.getTimeline",
        params: { cursor: "previous-page", limit: 100 },
      },
    ]);
    expect(result).toMatchObject({ items: [{ canonicalUri: postUri }], nextCursor: "next-page" });
  });

  it("supports an explicitly configured custom feed", async () => {
    const calls: Array<{ name: string; params?: Record<string, unknown> }> = [];
    const feed = "at://did:plc:feedowner/app.bsky.feed.generator/curious";
    const source = createAtprotoSource({
      ownerDid,
      stream: { kind: "feed", uri: feed },
      client: {
        get: async (name, init) => {
          calls.push({ name, params: init?.params });
          return { ok: true, data: { feed: [] } };
        },
      },
      safetyLabels: new Set(),
    });

    await source.sync();

    expect(calls).toEqual([
      { name: "app.bsky.feed.getFeed", params: { feed, cursor: undefined, limit: 100 } },
    ]);
  });

  it("surfaces failed XRPC responses for retry instead of committing an empty feed", async () => {
    const source = createAtprotoSource({
      ownerDid,
      client: { get: async () => ({ ok: false, status: 503, data: { error: "Unavailable" } }) },
      safetyLabels: new Set(),
    });

    await expect(source.sync()).rejects.toMatchObject({ status: 503 });
    await expect(source.tryHydrate(postUri)).rejects.toMatchObject({ status: 503 });
  });

  it("normalizes a canonical DID post URI and makes record-with-media inert safe blocks", async () => {
    const source = createAtprotoSource({
      ownerDid,
      client: { get: async () => ({ ok: true, data: { posts: [fullPost] } }) },
      safetyLabels: new Set(),
      now: () => "2026-08-28T12:05:00.000Z",
    });

    const result = await source.tryHydrate("at://renamed.example/app.bsky.feed.post/3kexample");

    expect(result).toMatchObject({
      canonicalUri: postUri,
      sourceId: "atproto",
      blocks: [
        { kind: "paragraph", text: "A thoughtful post with a https://unsafe.example facet" },
        { kind: "quote", text: "Quoted material", attribution: "Quoted" },
      ],
      media: [{ kind: "image", url: "https://cdn.example/full.jpg", alt: "Garden sketch" }],
      labels: [{ value: "sexual" }],
    });
    expect(JSON.stringify(result)).not.toContain("javascript:");
  });

  it("returns typed omissions for blocked, muted, labelled, and deleted protocol records", async () => {
    const variants = [
      {
        ...fullPost,
        author: {
          ...fullPost.author,
          viewer: { blocking: "at://did:plc:owner123/app.bsky.graph.block/3kblock" },
        },
      },
      { ...fullPost, author: { ...fullPost.author, viewer: { muted: true } } },
      fullPost,
      { $type: "app.bsky.feed.defs#notFoundPost", uri: postUri, notFound: true },
    ];
    let index = 0;
    const source = createAtprotoSource({
      ownerDid,
      client: { get: async () => ({ ok: true, data: { posts: [variants[index++]] } }) },
      safetyLabels: new Set(["sexual"]),
    });

    await expect(source.tryHydrate(postUri)).resolves.toMatchObject({
      kind: "omitted",
      reason: "blocked",
    });
    await expect(source.tryHydrate(postUri)).resolves.toMatchObject({
      kind: "omitted",
      reason: "muted",
    });
    await expect(source.tryHydrate(postUri)).resolves.toMatchObject({
      kind: "omitted",
      reason: "labelled",
    });
    await expect(source.tryHydrate(postUri)).resolves.toMatchObject({
      kind: "omitted",
      reason: "deleted",
    });
  });

  it("emits DID and canonical-URI bootstrap evidence with provenance for all cold-start signals", async () => {
    const source = createAtprotoSource({
      ownerDid,
      client: {
        get: async (name) => {
          if (name === "app.bsky.graph.getFollows")
            return {
              ok: true,
              data: { follows: [{ did: "did:plc:followed123", handle: "changed.example" }] },
            };
          if (name === "app.bsky.feed.getActorLikes")
            return { ok: true, data: { feed: [{ post: fullPost }] } };
          if (name === "app.bsky.graph.getActorStarterPacks")
            return {
              ok: true,
              data: {
                starterPacks: [{ uri: "at://did:plc:pack123/app.bsky.graph.starterpack/3kpack" }],
              },
            };
          return { ok: true, data: { feed: [{ post: fullPost }] } };
        },
      },
      safetyLabels: new Set(),
      now: () => "2026-08-28T12:05:00.000Z",
    });

    const evidence = await source.evidenceFor(ownerDid);

    expect(evidence).toHaveLength(4);
    expect(evidence.map((item) => item.subjectUri)).toEqual([
      "at://did:plc:followed123",
      postUri,
      "at://did:plc:pack123/app.bsky.graph.starterpack/3kpack",
      postUri,
    ]);
    expect(evidence.map((item) => item.tags[0].value)).toEqual([
      "follow",
      "like",
      "starter-pack",
      "authored",
    ]);
    expect(
      evidence.slice(1).every((item) => item.tags[0].provenance.reference === item.subjectUri),
    ).toBe(true);
    expect(evidence[0].tags[0].provenance.reference).toBeUndefined();
    expect(evidence.every((item) => EvidenceSchema.safeParse(item).success)).toBe(true);
  });

  it("hydrates through a session-bound XRPC client rather than a bearer token", async () => {
    const paths: string[] = [];
    const source = createAtprotoSourceFromSession({
      ownerDid,
      session: {
        handle: async (path) => {
          paths.push(path);
          return Response.json({ posts: [fullPost] });
        },
      } as never,
      safetyLabels: new Set(),
      now: () => "2026-08-28T12:05:00.000Z",
    });

    const result = await source.tryHydrate(postUri);

    expect(result).toMatchObject({ canonicalUri: postUri });
    expect(paths[0]).toContain("/xrpc/app.bsky.feed.getPosts");
  });

  it("sanitizes malformed protocol timestamps into schema-valid fallback values", async () => {
    const source = createAtprotoSource({
      ownerDid,
      client: {
        get: async () => ({
          ok: true,
          data: {
            posts: [
              {
                ...fullPost,
                indexedAt: "not-a-datetime",
                record: { ...fullPost.record, createdAt: "also-not-a-datetime" },
              },
            ],
          },
        }),
      },
      safetyLabels: new Set(),
      now: () => "not-a-datetime",
    });

    const result = await source.tryHydrate(postUri);
    expect(ContentEnvelopeSchema.safeParse(result).success).toBe(true);
    expect(JSON.stringify(result)).not.toContain("not-a-datetime");
  });

  it("returns a typed invalid omission instead of a malformed contract output", async () => {
    const source = createAtprotoSource({
      ownerDid,
      sourceId: " ",
      client: { get: async () => ({ ok: true, data: { posts: [fullPost] } }) },
      safetyLabels: new Set(),
    });

    await expect(source.tryHydrate(postUri)).resolves.toEqual({
      kind: "omitted",
      reason: "invalid",
      canonicalUri: postUri,
    });
  });

  it("keeps external and video embeds inert while producing a schema-valid envelope", async () => {
    const source = createAtprotoSource({
      ownerDid,
      client: {
        get: async () => ({
          ok: true,
          data: {
            posts: [
              {
                ...fullPost,
                embed: {
                  $type: "app.bsky.embed.external#view",
                  external: {
                    uri: "https://example.com/article",
                    title: "Read this",
                    description: "<script>never render</script>",
                  },
                },
              },
            ],
          },
        }),
      },
      safetyLabels: new Set(),
      now: () => "2026-08-28T12:05:00.000Z",
    });

    const external = await source.tryHydrate(postUri);
    expect(external).toMatchObject({
      blocks: expect.arrayContaining([
        { kind: "link", href: "https://example.com/article", text: "Read this" },
      ]),
    });
    expect(JSON.stringify(external)).not.toContain("<script>");
    expect(ContentEnvelopeSchema.safeParse(external).success).toBe(true);

    const videoSource = createAtprotoSource({
      ownerDid,
      client: {
        get: async () => ({
          ok: true,
          data: {
            posts: [
              {
                ...fullPost,
                embed: {
                  $type: "app.bsky.embed.video#view",
                  cid: "bafyvideo",
                  playlist: "https://video.example/playlist.m3u8",
                  thumbnail: "https://video.example/thumb.jpg",
                  aspectRatio: { width: 16, height: 9 },
                },
              },
            ],
          },
        }),
      },
      safetyLabels: new Set(),
      now: () => "2026-08-28T12:05:00.000Z",
    });
    await expect(videoSource.tryHydrate(postUri)).resolves.toMatchObject({
      media: [{ kind: "video", url: "https://video.example/playlist.m3u8" }],
    });
  });

  it("does not emit a quoted record when nested protocol moderation blocks it", async () => {
    const nested = {
      ...fullPost,
      labels: [],
      embed: {
        ...fullPost.embed,
        record: {
          ...fullPost.embed.record,
          record: {
            ...fullPost.embed.record.record,
            author: { ...fullPost.embed.record.record.author, viewer: { muted: true } },
            labels: [
              {
                src: "did:plc:labeler",
                uri: "at://did:plc:quoted123/app.bsky.feed.post/3kquoted",
                val: "sexual",
                cts: "2026-08-28T12:00:00.000Z",
              },
            ],
          },
        },
      },
    };
    const source = createAtprotoSource({
      ownerDid,
      client: { get: async () => ({ ok: true, data: { posts: [nested] } }) },
      safetyLabels: new Set(["sexual"]),
      now: () => "2026-08-28T12:05:00.000Z",
    });

    const result = await source.tryHydrate(postUri);

    expect(result).toMatchObject({
      media: [{ kind: "image", url: "https://cdn.example/full.jpg" }],
    });
    expect(JSON.stringify(result)).not.toContain("Quoted material");
  });

  it("omits nested deleted, blocked, muted, and safety-labelled record text", async () => {
    const nestedVariants = [
      { notFound: true },
      { deleted: true },
      { blocked: true },
      { author: { ...fullPost.embed.record.record.author, viewer: { muted: true } } },
      {
        labels: [
          {
            src: "did:plc:labeler",
            uri: "at://did:plc:quoted123/app.bsky.feed.post/3kquoted",
            val: "sexual",
            cts: "2026-08-28T12:00:00.000Z",
          },
        ],
      },
    ];
    let index = 0;
    const source = createAtprotoSource({
      ownerDid,
      client: {
        get: async () => ({
          ok: true,
          data: {
            posts: nestedVariants
              .map((variant) => ({
                ...fullPost,
                labels: [],
                embed: {
                  ...fullPost.embed,
                  record: {
                    ...fullPost.embed.record,
                    record: { ...fullPost.embed.record.record, ...variant },
                  },
                },
              }))
              .slice(index++, index),
          },
        }),
      },
      safetyLabels: new Set(["sexual"]),
      now: () => "2026-08-28T12:05:00.000Z",
    });

    for (const _variant of nestedVariants) {
      const result = await source.tryHydrate(postUri);
      expect(JSON.stringify(result)).not.toContain("Quoted material");
      expect(ContentEnvelopeSchema.safeParse(result).success).toBe(true);
    }
  });
});
