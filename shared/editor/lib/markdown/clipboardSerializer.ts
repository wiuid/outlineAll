/**
 * Applies the interchange rules used for copied document content.
 * This is intentionally separate from the document/export Markdown serializer.
 */
export function sanitizeClipboardMarkdown(markdown: string): string {
  return markdown
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\[([^\]]+)\]\((?:[^()]|\([^)]*\))*\)/g, "$1")
    .replace(/==([^=\n]+)==/g, "$1")
    .replace(/<span\s+data-text-color="[^"]*">/gi, "")
    .replace(/<\/span>/gi, "")
    .replace(/^(\s*)\*(?!\*)\s+/gm, "$1- ")
    .trim();
}

/**
 * Removes presentation and navigation semantics from the HTML clipboard
 * flavor while keeping bold text available to rich-text targets.
 */
export function sanitizeClipboardHTML(html: string): string {
  return html
    .replace(/<h[1-6](?:\s[^>]*)?>([\s\S]*?)<\/h[1-6]>/gi, "<p>$1</p>")
    .replace(/<a(?:\s[^>]*)?>([\s\S]*?)<\/a>/gi, "$1")
    .replace(
      /\s+(?:style|href|data-text-color|class)=(?:"[^"]*"|'[^']*')/gi,
      ""
    )
    .replace(/<ul(?:\s[^>]*)?>/gi, "<div>")
    .replace(/<\/ul>/gi, "</div>")
    .replace(/<li(?:\s[^>]*)?>/gi, "<div>- ")
    .replace(/<\/li>/gi, "</div>")
    .replace(/<ol(?:\s[^>]*)?>/gi, "<div>")
    .replace(/<\/ol>/gi, "</div>")
    .replace(/<span(?:\s[^>]*)?>/gi, "<span>");
}
