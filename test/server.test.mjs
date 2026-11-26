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

for (const event of ["deadline", "browser disconnect"]) {
  test(`Responses handles ${event} while waiting for downstream drain`, { timeout: 3_000 }, async t => {
    const deadline = new AbortController();
    t.mock.method(AbortSignal, "timeout", milliseconds => {
      assert.equal(milliseconds, 300_000);
      return deadline.signal;
    });
    const stalled = Promise.withResolvers();
    const turn = Promise.withResolvers();
    let upstreamSignal;
    const server = sdkServer({ upstreamOrigin: "https://id.example", origins: [],
      request: async (url, options) => {
        if (url.endsWith("/self")) return new Response();
        if (options.method === "GET") return Response.json(await turn.promise);
        upstreamSignal = options.signal;
        let started = false;
        return new Response(new ReadableStream({
          pull(controller) {
            if (!started) {
              started = true;
              controller.enqueue(new TextEncoder().encode("data: reply\n\n"));
              return;
            }
            controller.close();
            turn.resolve("reply");
          },
          cancel() { turn.resolve(null); },
        }, { highWaterMark: 0 }));
      },
    });
    server.prependOnceListener("request", (_req, res) => {
      t.mock.method(res, "write", () => {
        stalled.resolve();
        return false;
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    }));
    const path = `http://127.0.0.1:${server.address().port}/api/v1/proxy/s/llm-nyx/v1/responses`;
    const authorization = "Bearer child";
    const response = await fetch(path, {
      method: "POST", headers: { authorization, "content-type": "application/json" }, body: "{}",
    });
    assert.equal(response.status, 200);
    await stalled.promise;
    if (event === "deadline") {
      deadline.abort();
      await assert.rejects(response.text());
      assert.equal(await turn.promise, null);
    } else {
      await response.body.cancel();
      assert.equal(await turn.promise, "reply");
      assert.equal(upstreamSignal.aborted, false);
      const recovered = await fetch(path + "/original", { headers: { authorization } });
      assert.equal(await recovered.json(), "reply");
    }
  });
}

test("relay routes an operation to the chosen live connection under the same Agent Key login", async t => {
  const origin = "https://app.example";
  const id = "eb87caa2-ea66-47d9-8b9f-0d415b228c92";
  let active = true;
  let allowed = true;
  const operations = [];
  const server = sdkServer({ upstreamOrigin: "https://id.example", origins: [origin],
    request: async (url, init) => {
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer login");
      if (url.endsWith("/self")) {
        if (!active) return Response.json({}, { status: 401 });
        return Response.json({ api_key: { scopes: "proxy", effective_services: [{ id, slug: "tickets", is_active: allowed }] } });
      }
      operations.push({ url, method: init.method, body: init.body.toString(), headers: new Headers(init.headers) });
      return Response.json({ error: "operation_denied" }, { status: 403 });
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = "http://127.0.0.1:" + server.address().port;
  const route = "/api/v1/proxy/s/tickets/tickets/with%20space?view=compact&_nyxid_via=" + id;
  const headers = { origin, authorization: "Bearer login", "content-type": "application/json", "if-match": '"rev1"' };
  const operation = { method: "PATCH", headers, body: '{"closed":true}' };
  const preflight = await fetch(base + route, { method: "OPTIONS", headers: {
    origin, "access-control-request-method": "PATCH", "access-control-request-headers": "authorization,content-type,if-match",
  } });
  assert.equal(preflight.status, 204);
  const reply = await fetch(base + route, operation);
  assert.equal(reply.status, 403);
  assert.deepEqual(await reply.json(), { error: "operation_denied" });
  assert.equal(operations[0].url, "https://id.example" + route);
  assert.equal(operations[0].body, operation.body);
  assert.equal(operations[0].method, "PATCH");
  assert.equal(operations[0].headers.get("if-match"), '"rev1"');
  allowed = false;
  assert.equal((await fetch(base + route, operation)).status, 403);
  active = false;
  assert.equal((await fetch(base + route, operation)).status, 401);
  assert.equal(operations.length, 1);
  assert.equal((await fetch(base + "/api/v1/proxy/s/tickets/a%2Fb?_nyxid_via=" + id, operation)).status, 404);
});
