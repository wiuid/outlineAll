import {
  sanitizeClipboardHTML,
  sanitizeClipboardMarkdown,
} from "./clipboardSerializer";

describe("clipboard serializer", () => {
  test("uses hyphens for unordered lists without changing bold markdown", () => {
    expect(
      sanitizeClipboardMarkdown("# Title\n\n* item\n* **important**")
    ).toBe("Title\n\n- item\n- **important**");
  });

  test("removes markdown link destinations while preserving link text", () => {
    expect(
      sanitizeClipboardMarkdown("Read [the docs](https://example.com)")
    ).toBe("Read the docs");
  });

  test("removes highlight delimiters while preserving highlighted text", () => {
    expect(sanitizeClipboardMarkdown("This is ==highlighted== text")).toBe(
      "This is highlighted text"
    );
  });

  test("removes rich HTML labels while preserving bold text", () => {
    expect(
      sanitizeClipboardHTML(
        '<h2>Title</h2><p><a href="https://example.com"><strong style="color:red">Important</strong></a></p>'
      )
    ).toBe("<p>Title</p><p><strong>Important</strong></p>");
  });
});
