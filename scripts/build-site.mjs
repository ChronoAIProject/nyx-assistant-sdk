import { copyFile, mkdir, readFile } from "node:fs/promises";
import { build } from "esbuild";

const dist = "site/dist";
await mkdir(dist, { recursive: true });
const license = await readFile("node_modules/zod/LICENSE", "utf8");
await Promise.all([
  ...["index.html", "style.css"].map((name) => copyFile(`site/${name}`, `${dist}/${name}`)),
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
