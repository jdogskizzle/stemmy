import DOMPurify from "dompurify";
import { marked } from "marked";

// Links in rendered documents open in a new tab so playback isn't interrupted.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A" && node.getAttribute("href")) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

/** Render GitHub-flavored Markdown (tables, task lists...) to sanitized HTML. */
export function renderMarkdown(source: string): string {
  // breaks: a single newline is a line break, which is what lyrics expect.
  const html = marked.parse(source, { gfm: true, breaks: true, async: false }) as string;
  return DOMPurify.sanitize(html);
}

/**
 * Tidy Markdown exported from Google Docs (File → Download → Markdown). The export embeds every image as a
 * base64 data URI, which can make a one-page doc megabytes long, so those images are dropped.
 */
export function cleanImportedMarkdown(source: string): { text: string; removedImages: number } {
  let removed = 0;
  const dataRefs = new Set<string>();
  let text = source.replace(/\r\n?/g, "\n");
  // Reference definitions: [image1]: <data:image/png;base64,...>
  text = text.replace(/^[ \t]*\[([^\]\n]+)\]:[ \t]*<?data:image\/[^\s>]+>?[ \t]*$/gim, (_, label: string) => {
    dataRefs.add(label.toLowerCase());
    return "";
  });
  // Images that use those references: ![alt][image1]
  text = text.replace(/!\[[^\]\n]*\]\[([^\]\n]+)\]/g, (match, label: string) => {
    if (!dataRefs.has(label.toLowerCase())) return match;
    removed++;
    return "";
  });
  // Inline data images: ![alt](data:image/...)
  text = text.replace(/!\[[^\]\n]*\]\(\s*<?data:image\/[^)]*\)/gi, () => { removed++; return ""; });
  return { text: text.replace(/\n{3,}/g, "\n\n").trim() + "\n", removedImages: removed };
}

// ---------- editing helpers for the Markdown toolbar ----------

/**
 * Replace a range of a textarea's text. Goes through execCommand where supported so the browser's undo history
 * keeps working, and fires the input event React listens to.
 */
function replaceRange(el: HTMLTextAreaElement, start: number, end: number, insert: string, onFallback: () => void) {
  el.focus();
  el.setSelectionRange(start, end);
  if (!document.execCommand("insertText", false, insert)) {
    el.setRangeText(insert, start, end, "end");
    onFallback();
  }
}

/** Wrap the selection (or a placeholder) in `before`/`after`, e.g. **bold**. */
export function wrapSelection(el: HTMLTextAreaElement, before: string, after: string, placeholder: string, onFallback: () => void) {
  const { selectionStart: start, selectionEnd: end, value } = el;
  const selected = value.slice(start, end) || placeholder;
  replaceRange(el, start, end, before + selected + after, onFallback);
  el.setSelectionRange(start + before.length, start + before.length + selected.length);
}

/** Prefix every line touched by the selection (toggles off when all lines already have it). */
export function prefixLines(el: HTMLTextAreaElement, prefix: (i: number) => string, pattern: RegExp, onFallback: () => void) {
  const { selectionStart, selectionEnd, value } = el;
  const start = value.lastIndexOf("\n", selectionStart - 1) + 1;
  const nextBreak = value.indexOf("\n", selectionEnd);
  const end = nextBreak === -1 ? value.length : nextBreak;
  const lines = value.slice(start, end).split("\n");
  const all = lines.every((l) => pattern.test(l));
  const result = lines.map((l, i) => (all ? l.replace(pattern, "") : prefix(i) + l.replace(pattern, ""))).join("\n");
  replaceRange(el, start, end, result, onFallback);
  el.setSelectionRange(start, start + result.length);
}

/** Insert a block (e.g. a table) on its own lines at the cursor. */
export function insertBlock(el: HTMLTextAreaElement, block: string, onFallback: () => void) {
  const { selectionStart: start, selectionEnd: end, value } = el;
  const before = start > 0 && value[start - 1] !== "\n" ? "\n\n" : start > 1 && value[start - 2] !== "\n" ? "\n" : "";
  const after = value[end] === "\n" ? "\n" : "\n\n";
  replaceRange(el, start, end, before + block + after, onFallback);
}

export const TABLE_TEMPLATE = "| Column 1 | Column 2 |\n| --- | --- |\n|  |  |\n|  |  |";
