import DOMPurify from "dompurify";
import { Marked } from "marked";
import markedCjkFriendly from "marked-cjk-friendly";

function escapeMarkup(text: string) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

const markdown = new Marked(markedCjkFriendly(), {
  gfm: true,
  renderer: {
    html({ text }) { return escapeMarkup(text); },
    // Resolve images after parsing so a linked image keeps its outer destination.
    image({ href, text }) {
      return '<span data-nyx-image="' + escapeMarkup(href) + '">' + escapeMarkup(text) + '</span>';
    },
  },
});

function destination(href: string | null): URL | undefined {
  if (!href) return;
  try {
    const url = new URL(href, document.baseURI);
    if (["http:", "https:", "mailto:"].includes(url.protocol)) return url;
  } catch { /* An invalid destination remains readable as text. */ }
}

/** Render a confirmed assistant reply in the current browser document. */
export function renderAssistantMarkdown(source: string, imageLabel = "图片"): DocumentFragment {
  const fragment = DOMPurify.sanitize(markdown.parse(source, { async: false }), {
    RETURN_DOM_FRAGMENT: true, ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false,
    ALLOWED_TAGS: ["p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "em", "strong", "del", "blockquote",
      "ul", "ol", "li", "input", "pre", "code", "table", "thead", "tbody", "tr", "th", "td", "a", "span"],
    ALLOWED_ATTR: ["href", "title", "start", "align", "type", "disabled", "checked", "data-nyx-image"],
  });
  for (const placeholder of fragment.querySelectorAll<HTMLElement>("[data-nyx-image]")) {
    const url = destination(placeholder.dataset.nyxImage ?? null);
    const alt = placeholder.textContent || imageLabel;
    if (url?.protocol !== "https:" || placeholder.closest("a")) {
      placeholder.replaceWith(alt);
    } else {
      const link = document.createElement("a");
      link.href = url.href;
      link.textContent = alt;
      placeholder.replaceWith(link);
    }
  }
  for (const link of fragment.querySelectorAll("a")) {
    const url = destination(link.getAttribute("href"));
    if (!url) { link.replaceWith(...link.childNodes); continue; }
    link.href = url.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  }
  for (const table of fragment.querySelectorAll("table")) {
    const viewport = document.createElement("div");
    viewport.className = "table-scroll";
    table.replaceWith(viewport);
    viewport.append(table);
  }
  return fragment;
}
