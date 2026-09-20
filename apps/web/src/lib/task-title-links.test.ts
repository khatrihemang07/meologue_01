import { describe, expect, it } from "vitest";
import { titleLinkSegments } from "./task-title-links";

describe("titleLinkSegments", () => {
  it("returns a single plain segment for a title with no link syntax", () => {
    expect(titleLinkSegments("buy milk tomorrow")).toEqual([{ text: "buy milk tomorrow" }]);
  });

  it("returns an empty array for an empty title", () => {
    expect(titleLinkSegments("")).toEqual([]);
  });

  it("splits text before/after a link into their own plain segments", () => {
    expect(titleLinkSegments("Read [my article](https://example.com/post) before lunch")).toEqual([
      { text: "Read " },
      { text: "my article", href: "https://example.com/post" },
      { text: " before lunch" },
    ]);
  });

  it("returns a single link segment when the whole title is the link", () => {
    expect(titleLinkSegments("[Todoist](https://todoist.com)")).toEqual([
      { text: "Todoist", href: "https://todoist.com" },
    ]);
  });

  it("recognises more than one link in the same title", () => {
    expect(titleLinkSegments("[a](https://a.com) and [b](https://b.com)")).toEqual([
      { text: "a", href: "https://a.com" },
      { text: " and " },
      { text: "b", href: "https://b.com" },
    ]);
  });

  it("does not recognise an empty link text as a link", () => {
    expect(titleLinkSegments("See [](https://example.com) here")).toEqual([
      { text: "See [](https://example.com) here" },
    ]);
  });

  it("does not recognise an empty url as a link", () => {
    expect(titleLinkSegments("See [Todoist]() here")).toEqual([{ text: "See [Todoist]() here" }]);
  });

  it("leaves unbalanced brackets as plain text rather than breaking", () => {
    expect(titleLinkSegments("See [Todoist (no closing paren")).toEqual([
      { text: "See [Todoist (no closing paren" },
    ]);
    expect(titleLinkSegments("See Todoist](https://example.com) no opening bracket")).toEqual([
      { text: "See Todoist](https://example.com) no opening bracket" },
    ]);
  });
});
