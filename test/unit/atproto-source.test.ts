import { describe, expect, it } from "vitest";
import { createAtprotoSource, createAtprotoSourceFromSession } from "../../src/modules/sources/atproto";
import { EvidenceSchema } from "../../src/contracts";

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
    facets: [{ index: { byteStart: 25, byteEnd: 47 }, features: [{ $type: "app.bsky.richtext.facet#link", uri: "javascript:alert(1)" }] }],
  },
  author: { did: "did:plc:author123", handle: "renamed.example", displayName: "Author" },
  labels: [{ src: "did:plc:labeler", uri: postUri, val: "sexual", cts: "2026-08-28T12:00:00.000Z" }],
  embed: {
    $type: "app.bsky.embed.recordWithMedia#view",
    media: {
      $type: "app.bsky.embed.images#view",
      images: [{ thumb: "https://cdn.example/thumb.jpg", fullsize: "https://cdn.example/full.jpg", alt: "Garden sketch", aspectRatio: { width: 4, height: 3 } }],
    },
    record: {
      $type: "app.bsky.embed.record#view",
      record: {
        $type: "app.bsky.embed.record#viewRecord",
        uri: "at://did:plc:quoted123/app.bsky.feed.post/3kquoted",
        cid: "bafyquoted",
        value: { $type: "app.bsky.feed.post", text: "Quoted material", createdAt: "2026-08-28T10:00:00.000Z" },
        author: { did: "did:plc:quoted123", handle: "quoted.example", displayName: "Quoted" },
        labels: [],
      },
    },
  },
};

describe("AT Protocol source adapter", () => {
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
      { ...fullPost, author: { ...fullPost.author, viewer: { blocking: "at://did:plc:owner123/app.bsky.graph.block/3kblock" } } },
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

    await expect(source.tryHydrate(postUri)).resolves.toMatchObject({ kind: "omitted", reason: "blocked" });
    await expect(source.tryHydrate(postUri)).resolves.toMatchObject({ kind: "omitted", reason: "muted" });
    await expect(source.tryHydrate(postUri)).resolves.toMatchObject({ kind: "omitted", reason: "labelled" });
    await expect(source.tryHydrate(postUri)).resolves.toMatchObject({ kind: "omitted", reason: "deleted" });
  });

  it("emits DID and canonical-URI bootstrap evidence with provenance for all cold-start signals", async () => {
    const source = createAtprotoSource({
      ownerDid,
      client: {
        get: async (name) => {
          if (name === "app.bsky.graph.getFollows") return { ok: true, data: { follows: [{ did: "did:plc:followed123", handle: "changed.example" }] } };
          if (name === "app.bsky.feed.getActorLikes") return { ok: true, data: { feed: [{ post: fullPost }] } };
          if (name === "app.bsky.graph.getActorStarterPacks") return { ok: true, data: { starterPacks: [{ uri: "at://did:plc:pack123/app.bsky.graph.starterpack/3kpack" }] } };
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
    expect(evidence.map((item) => item.tags[0].value)).toEqual(["follow", "like", "starter-pack", "authored"]);
    expect(evidence.slice(1).every((item) => item.tags[0].provenance.reference === item.subjectUri)).toBe(true);
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
});
