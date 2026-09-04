import type Token from "markdown-it/lib/token.mjs";
import type { MarkdownSerializerState } from "prosemirror-markdown";
import type {
  Mark as ProsemirrorMark,
  MarkSpec,
  MarkType,
} from "prosemirror-model";
import { toggleMark } from "../commands/toggleMark";
import textColorRule from "../rules/textColor";
import Mark from "./Mark";

export const semanticTextColors = [
  { value: "light-red", name: "Light red", preview: "#c53030" },
  { value: "dark-red", name: "Dark red", preview: "#9b2c2c" },
  { value: "light-orange", name: "Light orange", preview: "#c05621" },
  { value: "dark-orange", name: "Dark orange", preview: "#9c4221" },
  { value: "light-yellow", name: "Light yellow", preview: "#975a16" },
  { value: "dark-yellow", name: "Dark yellow", preview: "#744210" },
  { value: "light-green", name: "Light green", preview: "#2f855a" },
  { value: "dark-green", name: "Dark green", preview: "#276749" },
  { value: "light-cyan", name: "Light cyan", preview: "#2c7a7b" },
  { value: "dark-cyan", name: "Dark cyan", preview: "#285e61" },
  { value: "light-blue", name: "Light blue", preview: "#2b6cb0" },
  { value: "dark-blue", name: "Dark blue", preview: "#2c5282" },
  { value: "light-purple", name: "Light purple", preview: "#6b46c1" },
  { value: "dark-purple", name: "Dark purple", preview: "#553c9a" },
  { value: "light-gray", name: "Light gray", preview: "#718096" },
  { value: "dark-gray", name: "Dark gray", preview: "#4a5568" },
] as const;

const legacyTextColors = ["red", "orange", "green", "blue", "purple", "gray"];

export type SemanticTextColor = (typeof semanticTextColors)[number]["value"];

export default class TextColor extends Mark {
  static colors = semanticTextColors;

  static isSupported(color: string): boolean {
    return (
      semanticTextColors.some((preset) => preset.value === color) ||
      legacyTextColors.includes(color)
    );
  }

  get name() {
    return "textColor";
  }

  get schema(): MarkSpec {
    return {
      attrs: {
        color: {
          default: null,
          validate: "string|null",
        },
      },
      parseDOM: [
        {
          tag: "span[data-text-color]",
          getAttrs: (dom) => {
            const color = dom.getAttribute("data-text-color") || "";
            return TextColor.isSupported(color) ? { color } : false;
          },
        },
      ],
      toDOM: (mark) => [
        "span",
        {
          "data-text-color": TextColor.isSupported(mark.attrs.color)
            ? mark.attrs.color
            : null,
        },
        0,
      ],
    };
  }

  keys({ type }: { type: MarkType }) {
    return {
      "Mod-Shift-c": toggleMark(type),
    };
  }

  get rulePlugins() {
    return [textColorRule];
  }

  toMarkdown() {
    return {
      open: (_state: MarkdownSerializerState, mark: ProsemirrorMark) =>
        `<span data-text-color="${mark.attrs.color}">`,
      close: "</span>",
      mixable: true,
      expelEnclosingWhitespace: true,
    };
  }

  parseMarkdown() {
    return {
      mark: "textColor",
      getAttrs: (token: Token) => ({
        color: token.attrGet("data-text-color"),
      }),
    };
  }
}
