import { readFile } from "node:fs/promises";
import { build } from "esbuild";

const licenses = await Promise.all(
  ["zod", "eventsource-parser", "marked", "marked-cjk-friendly", "dompurify"].map(async (name) => {
    const file = new URL(
      "../node_modules/" + name + "/LICENSE",
      import.meta.url,
    );
    return name + "\n" + (await readFile(file, "utf8")).trim();
  }),
);
await build({
  entryPoints: ["src/widget-script.ts"],
  outfile: "browser/nyx-widget.js",
  bundle: true,
  format: "iife",
  minify: true,
  target: "es2022",
  legalComments: "inline",
  banner: { js: "/*!\n" + licenses.join("\n\n") + "\n*/" },
});
