import { describe, expect, it } from "vitest";

import { normalizeContentHtml } from "../../src/modules/content";

describe("content normalization", () => {
  it("turns useful HTML into text and safe links while discarding active markup", () => {
    const blocks = normalizeContentHtml(
      '<p>Hello &amp; <a href="/essay" onclick="alert(1)">world</a><script>alert(1)</script><style>p{color:red}</style><iframe src="https://evil.example"></iframe><a href="javascript:alert(1)">bad</a></p>',
      "https://example.com/feed.xml",
    );

    expect(blocks).toEqual([
      { kind: "paragraph", text: "Hello & world bad" },
      { kind: "link", href: "https://example.com/essay", text: "world" },
    ]);
  });

  it("does not preserve executable media URL schemes", () => {
    expect(
      normalizeContentHtml('<img src="data:text/html,evil" alt="nope"><img src="/art.jpg" alt="Cover">', "https://example.com/feed.xml"),
    ).toEqual([{ kind: "image", src: "https://example.com/art.jpg", alt: "Cover" }]);
  });
});
