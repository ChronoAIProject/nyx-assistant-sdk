import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import { locales, relay } from "../site/locales.mjs";

const dist = "site/dist";
await mkdir(dist, { recursive: true });
const license = await readFile("node_modules/zod/LICENSE", "utf8");
const template = await readFile("site/index.html", "utf8");

function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

async function buildPage([locale, copy]) {
  const alternate = locales[copy.alternate];
  const values = {
    ...copy.page, ...copy.tickets.states, lang: copy.lang, locale, relay,
    alternate: copy.alternate, alternateLang: alternate.lang, alternateName: alternate.name,
  };
  const html = template.replaceAll(/\{\{(\w+)\}\}/g, (_token, key) => {
    if (!Object.hasOwn(values, key)) throw new Error(`Missing ${locale} translation for ${key}`);
    return escapeHtml(values[key]);
  });
  await mkdir(`${dist}/${locale}`, { recursive: true });
  await writeFile(`${dist}/${locale}/index.html`, html);
}

await Promise.all([
  ...Object.entries(locales).map(buildPage),
  writeFile(`${dist}/index.html`, `<!doctype html>
<html lang="${locales.zh.lang}">
<meta charset="utf-8">
<title>${escapeHtml(locales.zh.page.title)}</title>
<script>location.replace(new URL("./zh/" + location.search + location.hash, location.href));</script>
<a href="./zh/" lang="zh-CN">简体中文</a>
<a href="./en/" lang="en">English</a>
</html>
`),
  copyFile("site/style.css", `${dist}/style.css`),
  copyFile("browser/nyx-widget.js", `${dist}/nyx-widget.js`),
  build({
    entryPoints: ["site/playground.ts"],
    outfile: `${dist}/playground.js`,
    bundle: true,
    minify: true,
    target: "es2022",
    banner: { js: `/*!\nzod\n${license.trim()}\n*/` },
  }),
]);
