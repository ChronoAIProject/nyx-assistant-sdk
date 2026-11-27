import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { sdkServer } from "../server/server.mjs";

test("static server accepts any origin for scoped child requests and Responses streams", async t => {
  const origin = "https://new-site.example";
  const requests = [];
  const server = sdkServer({ upstreamOrigin: "https://id.example",
    request: async (url, options) => {
      const headers = new Headers(options.headers);
      requests.push({ url, headers, method: options.method });
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
  const preflightHeaders = { origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type,idempotency-key" };
  const pre = await fetch(path, { method: "OPTIONS", headers: preflightHeaders });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), "*");
  assert.equal(pre.headers.get("access-control-allow-methods"), "POST");
  assert.match(pre.headers.get("access-control-allow-headers"), /\bauthorization\b/);
  assert.equal(pre.headers.has("access-control-allow-credentials"), false);
  for (const headers of [
    { ...preflightHeaders, "Access-Control-Request-Method": "DELETE" },
    { ...preflightHeaders, "Access-Control-Request-Headers": "x-unsupported" },
  ]) assert.equal((await fetch(path, { method: "OPTIONS", headers })).status, 403);
  assert.equal(requests.length, 0);
  const result = await fetch(path, post);
  assert.equal(result.headers.get("access-control-allow-origin"), "*");
  assert.equal(await result.text(), "data: reply\n\n");
  assert.equal(result.headers.get("content-type"), "text/event-stream");
  assert.deepEqual(requests.map(row => new URL(row.url).pathname), ["/api/v1/auth/agent-key/self", "/api/v1/proxy/s/llm-nyx/v1/responses"]);
  assert.equal(requests[1].headers.get("idempotency-key"), "example");
  assert.equal(requests[1].headers.has("origin"), false);
  const denied = await fetch(path, { ...post, headers: { ...post.headers, authorization: "Bearer parent" } });
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get("access-control-allow-origin"), "*");
  assert.equal((await fetch(path, { ...post, headers: { ...post.headers, cookie: "session=fixture" } })).status, 403);
  for (const operation of ["request", "poll"]) {
    const result = await fetch(base + "auth/agent-key/" + operation, {
      method: "POST", headers: { origin: "https://another-site.example", "content-type": "application/json" }, body: "{}",
    });
    assert.equal(result.headers.get("access-control-allow-origin"), "*");
    assert.deepEqual(await result.json(), { ok: true });
    assert.equal(new URL(requests.at(-1).url).pathname, "/api/v1/auth/agent-key/" + operation);
  }
  for (const method of ["GET", "DELETE"]) {
    const child = await fetch(base + "auth/agent-key/self", { method, headers: { origin: "null", authorization: "Bearer child" } });
    assert.equal(child.headers.get("access-control-allow-origin"), "*");
    assert.equal(child.headers.has("set-cookie"), false);
    assert.deepEqual(await child.json(), { ok: true });
    assert.equal(requests.at(-1).method, method);
  }
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
    const server = sdkServer({ upstreamOrigin: "https://id.example",
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
