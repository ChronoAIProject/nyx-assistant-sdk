// Development server for one local operator. The Agent Key stays in this process.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { NyxIDConnection } from "@chronoai/nyx-assistant-sdk";
import { defaultLocale, locales } from "../../site/locales.mjs";
import { renderPage } from "../../site/render.mjs";
let localOrigin;
const template = await readFile(new URL("./index.html", import.meta.url), "utf8");
const pages = new Map(Object.keys(locales).map(locale => [`/${locale}/`, renderPage(template, locale)]));
pages.set("/", pages.get(`/${defaultLocale}/`));
const catalog = await readFile(new URL("../../site/locales.mjs", import.meta.url));
const app = await readFile(new URL("./app.js", import.meta.url));
const tickets = await readFile(new URL("./tickets.js", import.meta.url));
const widget = await readFile(new URL("../../browser/nyx-widget.js", import.meta.url));
const assets = new Map([["/locales.mjs", catalog], ["/app.js", app], ["/tickets.js", tickets], ["/nyx-widget.js", widget]]);
const upstream = process.env.NYXID_BASE_URL && process.env.NYXID_AGENT_KEY
  ? new NyxIDConnection(process.env.NYXID_BASE_URL, (url, init) => {
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${process.env.NYXID_AGENT_KEY}`);
      return fetch(url, { ...init, headers });
    }) : undefined;

const server = createServer(async (req, res) => {
  const end = (status, body = "") => { res.statusCode = status; res.end(body); };
  try {
    if (req.headers.host !== new URL(localOrigin).host) return end(403);
    if (req.method === "GET" && (pages.has(req.url) || assets.has(req.url))) {
      res.setHeader("Content-Type", pages.has(req.url) ? "text/html; charset=utf-8" : "text/javascript");
      return end(200, pages.get(req.url) ?? assets.get(req.url));
    }
    const match = /^\/api\/v1\/proxy\/s\/llm-nyx\/v1\/responses(?:\/([A-Za-z0-9_-]+))?$/.exec(req.url);
    if (!match || req.method !== (match[1] ? "GET" : "POST")) return end(404);
    if (req.headers["sec-fetch-site"] !== "same-origin" || (req.method === "POST" && req.headers.origin !== localOrigin)) return end(403);
    if (!upstream) {
      const pageUrl = URL.parse(req.headers.referer ?? "");
      const locale = pageUrl?.origin === localOrigin ? pageUrl.pathname.split("/")[1] : defaultLocale;
      const copy = Object.hasOwn(locales, locale) ? locales[locale] : locales[defaultLocale];
      return end(503, copy.page.configureServer);
    }
    let body = "";
    req.setEncoding("utf8");
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 256 * 1024) return end(413);
    }
    const headers = { "Content-Type": "application/json", Accept: "text/event-stream, application/json" };
    if (req.method === "POST") {
      const data = JSON.parse(body);
      if (data.model !== "nyxagent/chat") return end(400);
      headers["Idempotency-Key"] = req.headers["idempotency-key"];
    }
    const path = match[1] ? ["v1", "responses", match[1]] : ["v1", "responses"];
    const reply = await upstream.request("llm-nyx", path, { method: req.method, body: body || undefined, headers });
    res.writeHead(reply.status, { "Content-Type": reply.headers.get("content-type") ?? "application/json", "Cache-Control": "no-store" });
    if (reply.body) await pipeline(Readable.fromWeb(reply.body), res);
    else res.end();
  } catch {
    if (!res.headersSent) end(502); else res.destroy();
  }
});
server.listen(0, "127.0.0.1", () => {
  localOrigin = `http://127.0.0.1:${server.address().port}`;
  console.log(localOrigin);
});
