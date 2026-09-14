import type { Node as ProsemirrorNode } from "prosemirror-model";
import { Fragment, Slice } from "prosemirror-model";
import { TextSelection } from "prosemirror-state";
import { p, parser, schema, serializer } from "../../../test/editor";
import {
  createClipboardTextSerializer,
  sanitizeClipboardHTML,
} from "./clipboardSerializer";

const serialize = createClipboardTextSerializer(serializer);

/** Serializes actual document nodes using the ordinary clipboard rules. */
function copyNodes(...nodes: ProsemirrorNode[]) {
  return serialize(new Slice(Fragment.from(nodes), 0, 0));
}

describe("clipboard serializer", () => {
  test("uses hyphens for unordered lists without changing bold markdown", () => {
    const doc = parser.parse("# Title\n\n* item\n* **important**");
    expect(doc).not.toBeNull();
    if (doc) {
      expect(serialize(new Slice(doc.content, 0, 0))).toBe(
        "Title\n\n- item\n- **important**"
      );
    }
  });

  test("removes markdown link destinations while preserving link text", () => {
    const link = schema.marks.link.create({ href: "https://example.com" });
    expect(
      copyNodes(
        schema.nodes.paragraph.create(null, [
          schema.text("Read "),
          schema.text("the docs", [link]),
        ])
      )
    ).toBe("Read the docs");
  });

  test("removes highlight delimiters while preserving highlighted text", () => {
    expect(
      copyNodes(
        schema.nodes.paragraph.create(null, [
          schema.text("This is "),
          schema.text("highlighted", [schema.marks.highlight.create()]),
          schema.text(" text"),
        ])
      )
    ).toBe("This is highlighted text");
  });

  test("removes text colors while preserving bold special characters", () => {
    expect(
      copyNodes(
        schema.nodes.paragraph.create(
          null,
          schema.text("-5 * 2", [
            schema.marks.strong.create(),
            schema.marks.textColor.create({ color: "#ff0000" }),
          ])
        )
      )
    ).toBe("**-5 * 2**");
  });

  test.each([
    "-5",
    "- item",
    "+flag",
    "# literal heading",
    "1. literal number",
    "a * b",
    "`literal code`",
    "~home",
    "C:\\Temp\\script.py",
    "\\- already escaped",
    "[label](https://example.com)",
    "==literal highlight==",
    '<span data-text-color="red">literal HTML</span>',
  ])("preserves literal paragraph text %j", (text) => {
    expect(copyNodes(p(text))).toBe(text);
  });

  test.each(["code_block", "code_fence"])(
    "copies a partial %s without changing code or adding fences",
    (type) => {
      const prefix = "unselected before\n";
      const code = [
        "    # keep the comment and indentation",
        '    path = r"C:\\Temp\\script.py"',
        '    pattern = r"\\d+\\s"',
        '    literal = "[label](url) ==value== <span>text</span>"',
        "    ```",
        "",
      ].join("\n");
      const doc = schema.nodes.doc.create(
        null,
        schema.nodes[type].create(
          { language: "python" },
          schema.text(`${prefix}${code}unselected after`)
        )
      );
      const from = prefix.length + 1;
      const selected = TextSelection.create(doc, from, from + code.length);

      expect(serialize(selected.content())).toBe(code);
      expect(doc.textContent).toBe(`${prefix}${code}unselected after`);
    }
  );

  test("preserves code whitespace at the edges of a mixed selection", () => {
    const code = schema.nodes.code_fence.create(
      { language: "python" },
      schema.text("  # comment\n  value = -5\n")
    );
    expect(copyNodes(code, p("After"))).toBe(
      "  # comment\n  value = -5\n\nAfter"
    );
    expect(copyNodes(p("Before"), code)).toBe(
      "Before\n\n  # comment\n  value = -5\n"
    );
  });

  test("preserves whitespace when only indentation is selected", () => {
    const doc = schema.nodes.doc.create(
      null,
      schema.nodes.code_fence.create(null, schema.text("\t    value"))
    );
    expect(serialize(TextSelection.create(doc, 1, 6).content())).toBe("\t    ");
  });

  test("preserves ordered list numbering and nested unordered items", () => {
    const doc = parser.parse("3. One\n4. Two\n   * Nested");
    expect(doc).not.toBeNull();
    if (doc) {
      expect(serialize(new Slice(doc.content, 0, 0))).toBe(
        "3. One\n4. Two\n   - Nested"
      );
    }
  });

  test("keeps Markdown export escaped and fenced after copying", () => {
    const code = schema.nodes.code_fence.create(
      { language: "python" },
      schema.text("print(-5)")
    );
    const doc = schema.nodes.doc.create(null, [p("- literal"), code]);
    const before = serializer.serialize(doc, { commonMark: true });

    expect(serialize(new Slice(doc.content, 0, 0))).toBe(
      "- literal\n\nprint(-5)"
    );
    expect(serializer.serialize(doc, { commonMark: true })).toBe(before);
    expect(before).toBe("\\- literal\n\n```python\nprint(-5)\n```");
  });

  test("removes rich HTML labels while preserving bold text", () => {
    expect(
      sanitizeClipboardHTML(
        '<h2>Title</h2><p><a href="https://example.com"><strong style="color:red">Important</strong></a></p>'
      )
    ).toBe("<p>Title</p><p><strong>Important</strong></p>");
  });
});
