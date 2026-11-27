import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import { renderPage, renderIndex } from "../site/render.mjs";
import { locales } from "../site/locales.mjs";

const dist = "site/dist";
await mkdir(dist, { recursive: true });
const license = await readFile("node_modules/zod/LICENSE", "utf8");
const template = await readFile("site/index.html", "utf8");

async function buildPage(locale) {
  await mkdir(`${dist}/${locale}`, { recursive: true });
  await writeFile(`${dist}/${locale}/index.html`, renderPage(template, locale));
}

await Promise.all([
  ...Object.keys(locales).map(buildPage),
  writeFile(`${dist}/index.html`, renderIndex()),
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
