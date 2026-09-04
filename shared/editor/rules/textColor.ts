import type MarkdownIt from "markdown-it";
import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";

const openingPattern =
  /^<span\s+data-text-color=["'](red|orange|green|blue|purple|gray)["']\s*>/i;
const closingPattern = /^<\/span\s*>/i;

/**
 * Markdown-it plugin for semantic text colors.
 *
 * Syntax: <span data-text-color="red">Danger</span>
 */
export default function textColorRule(md: MarkdownIt) {
  md.inline.ruler.before(
    "html_inline",
    "textColor",
    (state: StateInline, silent: boolean) => {
      const source = state.src.slice(state.pos);
      const opening = source.match(openingPattern);
      if (opening) {
        if (!silent) {
          const token = state.push("textColor_open", "span", 1);
          token.attrs = [["data-text-color", opening[1].toLowerCase()]];
          token.markup = opening[0];
        }
        state.pos += opening[0].length;
        return true;
      }

      const closing = source.match(closingPattern);
      if (closing) {
        const openDepth = state.tokens.reduce((depth, token) => {
          if (token.type === "textColor_open") {
            return depth + 1;
          }
          if (token.type === "textColor_close") {
            return depth - 1;
          }
          return depth;
        }, 0);
        if (openDepth <= 0) {
          return false;
        }

        if (!silent) {
          const token = state.push("textColor_close", "span", -1);
          token.markup = closing[0];
        }
        state.pos += closing[0].length;
        return true;
      }

      return false;
    }
  );
}
