import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { sdkServer } from "../server/server.mjs";

test("static server forwards scoped child requests, streams Responses, and isolates origins", async t => {
  const origin = "https://site.example";
  const requests = [];
  const server = sdkServer({ upstreamOrigin: "https://id.example", origins: [origin],
    request: async (url, options) => {
      const headers = new Headers(options.headers);
      requests.push({ url, headers });
      if (url.endsWith("/self") && headers.get("authorization") !== "Bearer child") return Response.json({}, { status: 401 });
      if (url.endsWith("/responses")) return new Response("data: reply\n\n", { headers: { "content-type": "text/event-stream" } });
      return Response.json({ ok: true }, { headers: { "set-cookie": "private=1" } });
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = "http://127.0.0.1:" + server.address().port + "/api/v1/";
  const path = base + "proxy/s/llm-nyx/v1/responses";
  const post = { method: "POST", headers: { origin, authorization: "Bearer child", "content-type": "application/json", "idempotency-key": "example" }, body: "{}" };
  const pre = await fetch(path, { method: "OPTIONS", headers: { origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,idempotency-key" } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), origin);
  assert.equal(pre.headers.has("access-control-allow-credentials"), false);
  const result = await fetch(path, post);
  assert.equal(await result.text(), "data: reply\n\n");
  assert.equal(result.headers.get("content-type"), "text/event-stream");
  assert.deepEqual(requests.map(row => new URL(row.url).pathname), ["/api/v1/auth/agent-key/self", "/api/v1/proxy/s/llm-nyx/v1/responses"]);
  assert.equal(requests[1].headers.get("idempotency-key"), "example");
  assert.equal(requests[1].headers.has("origin"), false);
  assert.equal((await fetch(path, { ...post, headers: { ...post.headers, authorization: "Bearer parent" } })).status, 401);
  assert.equal((await fetch(path, { ...post, headers: { ...post.headers, cookie: "session=fixture" } })).status, 403);
  assert.equal((await fetch(path, { ...post, headers: { ...post.headers, origin: "https://other.example" } })).status, 403);
  const child = await fetch(base + "auth/agent-key/self", { headers: { origin, authorization: "Bearer child" } });
  assert.equal(child.headers.has("set-cookie"), false);
  assert.equal((await fetch(base + "auth/agent-key/approve", post)).status, 404);
  assert.equal((await fetch(path + "/original", { headers: { origin, authorization: "Bearer child" } })).status, 200);
});
