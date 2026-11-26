import { addAbortListener } from "node:events";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

import { attachVoiceStreams, voiceMethods } from "./voice.mjs";

const auth = "/api/v1/auth/agent-key/";
const responses = "/api/v1/proxy/s/llm-nyx/v1/responses";
const allowedHeaders = ["accept", "authorization", "content-type", "idempotency-key"];

const inferencePath = /^\/api\/v1\/proxy\/s\/(?<slug>[a-z0-9][a-z0-9-]*)\/(?<operation>realtime\/calls|v1\/responses(?:\/[A-Za-z0-9_-]{1,256})?)\?_nyxid_via=(?<id>[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})$/;

function methods(path, scoped) {
  if (scoped) return [scoped.operation.startsWith("v1/responses/") ? "GET" : "POST"];
  if (path === auth + "request" || path === auth + "poll" || path === responses) return ["POST"];
  if (path === auth + "self") return ["GET", "DELETE"];
  if (path.startsWith(responses + "/") && /^[A-Za-z0-9_-]{1,256}$/.test(path.slice(responses.length + 1))) return ["GET"];
  return voiceMethods(path);
}

function fail(res, status, error) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error }));
}

async function requestBody(req) {
  const parts = [];
  let size = 0;
  for await (const part of req.iterator({ destroyOnReturn: false })) {
    size += part.length;
    if (size > 1024 * 1024) return null;
    parts.push(part);
  }
  return Buffer.concat(parts);
}

function untilWritable(res) {
  return new Promise(resolve => {
    const finish = () => {
      res.off("close", finish);
      res.off("drain", finish);
      resolve();
    };
    res.once("close", finish);
    res.once("drain", finish);
    if (res.destroyed) finish();
  });
}

async function send(res, upstream, signal, completeTurn = false) {
  signal.throwIfAborted();
  for (const name of ["content-type", "retry-after"]) {
    const value = upstream.headers.get(name);
    if (value) res.setHeader(name, value);
  }
  if (!res.destroyed) {
    const abort = addAbortListener(signal, () => res.destroy());
    res.once("close", () => abort[Symbol.dispose]());
    res.writeHead(upstream.status);
    res.flushHeaders();
  }
  if (completeTurn && upstream.body) {
    // Like Metaverse, allow NyxAgent to store the result after the browser disconnects.
    for await (const chunk of upstream.body) {
      if (!res.destroyed && !res.write(chunk)) await untilWritable(res);
      signal.throwIfAborted();
    }
    if (!res.destroyed) res.end();
    return;
  }
  if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), res);
  else res.end();
}

function exactOrigin(input) {
  const url = new URL(input);
  if (url.origin !== input || (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new Error("Expected an HTTPS origin or a loopback HTTP origin");
  }
  return url.origin;
}

export function sdkServer({ upstreamOrigin, origins, request = fetch }) {
  const upstream = exactOrigin(upstreamOrigin);
  const allowed = new Set(origins.map(exactOrigin));
  const server = createServer(async (req, res) => {
    const path = req.url;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (req.method === "GET" && path === "/healthz") { res.end("ok"); return; }
    const scoped = inferencePath.exec(path)?.groups;
    const verbs = methods(path, scoped);
    if (!verbs.length) return fail(res, 404, "unknown_route");
    const origin = req.headers.origin;
    res.setHeader("Vary", "Origin, Access-Control-Request-Method, Access-Control-Request-Headers");
    if (origin !== undefined && !allowed.has(origin)) return fail(res, 403, "origin_denied");
    if (origin !== undefined) res.setHeader("Access-Control-Allow-Origin", origin);
    if (req.headers.cookie !== undefined) return fail(res, 403, "cookie_denied");
    if (req.method === "OPTIONS") {
      const wanted = (req.headers["access-control-request-headers"] ?? "").toLowerCase().split(",").map(s => s.trim()).filter(Boolean);
      if (!origin || !verbs.includes(req.headers["access-control-request-method"]) ||
          !wanted.every(header => allowedHeaders.includes(header))) return fail(res, 403, "preflight_denied");
      res.writeHead(204, { "Access-Control-Allow-Methods": verbs.join(", "), "Access-Control-Allow-Headers": allowedHeaders.join(", ") });
      res.end(); return;
    }
    if (!verbs.includes(req.method)) return fail(res, 405, "method_denied");
    const login = path === auth + "request" || path === auth + "poll";
    const bearer = req.headers.authorization;
    if (login && bearer) return fail(res, 400, "unexpected_authorization");
    if (!login && !/^Bearer [^\s,]+$/i.test(bearer ?? "")) return fail(res, 401, "child_required");
    if (req.method === "POST") {
      const mime = req.headers["content-type"]?.split(";")[0].trim().toLowerCase();
      if (scoped?.operation === "realtime/calls") {
        if (mime !== "multipart/form-data") return fail(res, 415, "multipart_required");
      } else if (mime !== "application/json") return fail(res, 415, "json_required");
    }

    const controller = new AbortController();
    const cancel = () => controller.abort();
    const completeTurn = (path === responses || scoped?.operation === "v1/responses") && req.method === "POST";
    if (!completeTurn) res.once("close", cancel);
    const options = { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(300_000)]), redirect: "error" };
    try {
      const body = req.method === "POST" ? await requestBody(req) : undefined;
      if (body === null) return fail(res, 413, "request_too_large");
      const headers = new Headers();
      for (const name of allowedHeaders) {
        if (req.headers[name] !== undefined) headers.set(name, req.headers[name]);
      }
      if (!login && path !== auth + "self") {
        const self = await request(upstream + auth + "self", { ...options, headers: { Authorization: bearer } });
        if (!self.ok) return await send(res, self, options.signal);
        if (scoped) {
          const identity = await self.json();
          const catalog = scoped.operation === "realtime/calls" ? "llm-openai" : "llm-nyx";
          if (!identity.api_key?.effective_services?.some(row => row.is_active && row.id === scoped.id &&
              row.slug === scoped.slug && (row.catalog_service_slug ?? row.slug) === catalog))
            return fail(res, 403, "connection_denied");
        } else await self.body?.cancel();
      }
      const result = await request(upstream + path, { ...options, method: req.method, headers, body });
      await send(res, result, options.signal, completeTurn);
    } catch {
      if (!res.headersSent && !res.destroyed) fail(res, 502, "nyxid_unavailable");
      else res.destroy();
    } finally {
      res.off("close", cancel);
    }
  });
  return attachVoiceStreams(server, upstream, allowed, request);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = sdkServer({
    upstreamOrigin: process.env.NYXID_ORIGIN ?? "https://nyx-api.chrono-ai.fun",
    origins: (process.env.SDK_ORIGINS ?? "").split(",").map(s => s.trim()).filter(Boolean),
  });
  server.listen(Number(process.env.PORT ?? 8080), "0.0.0.0");
  process.once("SIGTERM", () => server.close());
}
