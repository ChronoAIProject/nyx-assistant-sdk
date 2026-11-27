import { defaultLocale, locales, relay } from "./locales.mjs";

function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function languageLinks(current, prefix) {
  return Object.entries(locales).filter(([locale]) => locale !== current).map(([locale, copy]) => {
    const lang = escapeHtml(copy.lang);
    return `<a href="${prefix}${encodeURIComponent(locale)}/" lang="${lang}" hreflang="${lang}">${escapeHtml(copy.name)}</a>`;
  }).join("\n");
}

export function renderPage(template, locale) {
  const copy = locales[locale];
  const values = { ...copy.page, ...copy.tickets.states, lang: copy.lang, locale, relay };
  return template.replaceAll(/\{\{(\w+)\}\}/g, (_token, key) => {
    if (key === "languageLinks") return languageLinks(locale, "../");
    if (key === "alternateLinks") return Object.entries(locales).map(([id, item]) =>
      `<link rel="alternate" hreflang="${escapeHtml(item.lang)}" href="../${encodeURIComponent(id)}/">`
    ).join("\n");
    if (!Object.hasOwn(values, key)) throw new Error(`Missing ${locale} translation for ${key}`);
    return escapeHtml(values[key]);
  });
}

export function renderIndex() {
  const copy = locales[defaultLocale];
  return `<!doctype html>
<html lang="${escapeHtml(copy.lang)}">
<meta charset="utf-8">
<title>${escapeHtml(copy.page.title)}</title>
<script>location.replace(new URL(${JSON.stringify("./" + encodeURIComponent(defaultLocale) + "/")} + location.search + location.hash, location.href));</script>
${languageLinks(undefined, "./")}
</html>
`;
}
